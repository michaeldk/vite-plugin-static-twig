import fs from 'fs';
import path from 'path';
import Twig from 'twig';
import type { SiteUtils } from '../site-utils.js';

export type TwigFilterFn = (value: unknown, args: unknown[] | false) => unknown;

export interface TwigFilter {
    name: string;
    fn: TwigFilterFn;
}

export interface RenderContext {
    isBuild: boolean;
    useViteDevServer: boolean;
    viteDevBase: string;
}

export interface TwigPagesOptions {
    srcDir: string;
    staticDir: string;
    templatesDir: string;
    translationsDir: string;
    slugMapPath?: string | null;
    useViteAssetsInBuild: boolean;
    locales?: string[];
    defaultLocale?: string;
    scriptsEntryKey?: string;
    filters?: TwigFilter[];
    projectRoot: string;
    outDir: string;
    walkFiles: SiteUtils['walkFiles'];
    ensureDir: SiteUtils['ensureDir'];
    loadJson: SiteUtils['loadJson'];
}

interface ViteManifestEntry {
    file?: string;
    css?: string[];
    [key: string]: unknown;
}

type ViteManifest = Record<string, ViteManifestEntry>;

type SlugMap = Record<string, string[]>;

/**
 * Creates a task that renders Twig page templates into static HTML files.
 *
 * Each `.twig` file under `staticDir` (excluding underscore-prefixed files)
 * is treated as a page entry. Language is inferred from the directory structure,
 * translations are loaded per language, and asset paths are made relative to
 * each output file's location.
 */
function createTwigPagesTask(options: TwigPagesOptions): { renderTwigPages: (context: RenderContext) => Promise<void> } {
    const {
        srcDir: _srcDir,
        staticDir,
        templatesDir,
        translationsDir,
        slugMapPath,
        useViteAssetsInBuild,
        locales = ['fr', 'en', 'nl', 'de'],
        defaultLocale = 'fr',
        scriptsEntryKey = 'src/js/scripts.js',
        filters = [],
        projectRoot,
        outDir,
        walkFiles,
        ensureDir,
        loadJson
    } = options;

    const localePattern = new RegExp(`[\\\\/](${locales.join('|')})[\\\\/]`);

    /**
     * Infers the locale from a file path by looking for a language-code segment
     * matching one of the configured `locales`. Defaults to `defaultLocale` if
     * none is found.
     */
    function detectLanguage(filePath: string): string {
        const match = filePath.match(localePattern);
        return match ? match[1] : defaultLocale;
    }

    /**
     * Calculates the relative path prefix needed to reach the asset root from
     * the output HTML file's location (e.g. `'../../'` for a file two levels deep).
     * Returns an empty string for files at the root of the output directory.
     */
    function calculateAssetPath(filePath: string, staticRoot: string, outputRoot: string): string {
        const outputPath = filePath.replace(/\.twig$/, '.html').replace(staticRoot, outputRoot);
        const relativePath = path.relative(outputRoot, outputPath);
        const dirname = path.dirname(relativePath);
        const depth = dirname === '.' ? 0 : dirname.split(path.sep).length;
        return depth > 0 ? '../'.repeat(depth) : '';
    }

    /**
     * Builds a map of `{ targetLang: relativeUrl }` for the language-switcher
     * links of a given page, resolved at build time from the slug translation map.
     *
     * Returns an empty object when the page has no translatable lang prefix or
     * when any slug cannot be found in the map.
     */
    function buildLangSwitcherUrls(
        outputRelative: string,
        lang: string,
        slugMap: SlugMap,
        assetPath: string
    ): Record<string, string> {
        const normalized = outputRelative.split(path.sep).join('/');
        const langPrefix = `${lang}/`;

        if (!normalized.startsWith(langPrefix) || !slugMap[lang]) return {};

        const slugs = normalized
            .slice(langPrefix.length)
            .replace(/\.html$/, '')
            .split('/')
            .filter(Boolean);

        const indices = slugs.map(slug => slugMap[lang].indexOf(slug));
        if (indices.some(i => i === -1)) return {};

        const urls: Record<string, string> = {};
        for (const targetLang of Object.keys(slugMap)) {
            if (targetLang === lang || !slugMap[targetLang]) continue;

            const translatedSlugs = indices.map(i => (slugMap[targetLang] as string[])[i]);
            if (translatedSlugs.some(s => !s)) continue;

            urls[targetLang] = `${assetPath}${targetLang}/${translatedSlugs.join('/')}.html`;
        }

        return urls;
    }

    /**
     * Resolves a Vite manifest entry by trying `preferredKeys` first, then
     * falling back to a predicate scan of all entries. Returns `undefined` if
     * nothing matches.
     */
    function getViteManifestEntry(
        manifest: ViteManifest,
        preferredKeys: string[],
        fallbackMatcher: (key: string, value: ViteManifestEntry) => boolean
    ): ViteManifestEntry | undefined {
        for (const key of preferredKeys) {
            if (manifest[key]) {
                return manifest[key];
            }
        }
        return Object.entries(manifest).find(([key, value]) => fallbackMatcher(key, value))?.[1];
    }

    /**
     * Reads the Vite build manifest and extracts the hashed JS and CSS asset
     * paths for the main `scripts` entry point.
     * Returns `{}` when the manifest does not exist (dev mode).
     */
    async function loadViteAssets(): Promise<{ js?: string; css?: string }> {
        const manifestPath = path.join(outDir, '.vite', 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return {};
        }

        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as ViteManifest;
        const entryBasename = path.basename(scriptsEntryKey);
        const entryStem = path.basename(scriptsEntryKey, path.extname(scriptsEntryKey));
        const scriptsEntry = getViteManifestEntry(
            manifest,
            [scriptsEntryKey, entryStem],
            (key, value) => key.endsWith(entryBasename) || String(value?.file ?? '').includes(entryStem)
        );

        return {
            js: scriptsEntry?.file ?? '',
            css: scriptsEntry?.css?.[0] ?? ''
        };
    }

    /**
     * Registers custom Twig filters on the shared Twig instance:
     *
     * - `external_links` — Adds `target="_blank"`, `rel="noopener noreferrer"`,
     *   and a screen-reader label to external URLs and file download links.
     * - `entity_encode` — HTML-entity-encodes `mailto:` and `tel:` link hrefs
     *   and their visible text to deter scraper harvesting.
     *
     * Safe to call multiple times; Twig silently overwrites existing filters.
     */
    function registerTwigFilters(): void {
        Twig.extendFilter('external_links', function(value: unknown, args: unknown[] | false) {
            const lang = Array.isArray(args) ? (args[0] as string) ?? 'fr' : 'fr';
            if (!value || typeof value !== 'string') return value;

            const externalLabels: Record<string, string> = {
                fr: 'Nouvelle fenêtre',
                nl: 'Nieuw venster',
                de: 'neues Fenster',
                en: 'New window'
            };

            const fileExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx', 'zip'];
            const label = externalLabels[lang] ?? externalLabels['fr'];

            return value.replace(/<a\b([^>]*)>(.*?)<\/a>/gis, (match, attrs: string, text: string) => {
                const hrefMatch = (attrs as string).match(/href\s*=\s*["']([^"']+)["']/i);
                if (!hrefMatch) return match;

                const href = hrefMatch[1];
                if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
                    return match;
                }

                const ext = href.split('?')[0].split('.').pop()!.toLowerCase();
                const isDownload = fileExtensions.includes(ext);
                const isExternal = /^(https?:\/\/|www\.)/i.test(href);

                if (!isExternal && !isDownload) return match;

                if (!/target\s*=\s*["']_blank["']/.test(attrs)) {
                    attrs += ' target="_blank"';
                }

                if (!/rel\s*=/.test(attrs)) {
                    attrs += ' rel="noopener noreferrer"';
                }

                if (!text.includes('sr-only')) {
                    const labelText = isDownload ? `.${ext} — ${label}` : label;
                    text += `<span class="sr-only"> (${labelText})</span>`;
                }

                return `<a${attrs}>${text}</a>`;
            });
        });

        Twig.extendFilter('entity_encode', function(value: unknown) {
            if (!value || typeof value !== 'string') return value;

            const encode = (str: string): string =>
                str
                    .split('')
                    .map((char) => `&#${char.charCodeAt(0)};`)
                    .join('');

            return value.replace(
                /<a\s([^>]*)>(.*?)<\/a>/gis,
                (match, attrs: string, text: string) => {
                    const hrefMatch = attrs.match(/href\s*=\s*["']((?:mailto|tel):[^"']+)["']/i);
                    if (!hrefMatch) return match;

                    const encodedAttrs = attrs.replace(
                        /(href\s*=\s*["'])(?:mailto|tel):[^"']+(?=["'])/i,
                        (_, prefix: string) => prefix + encode(hrefMatch[1])
                    );

                    return `<a ${encodedAttrs}>${encode(text)}</a>`;
                }
            );
        });

        for (const { name, fn } of filters) {
            Twig.extendFilter(name, fn);
        }
    }

    /**
     * Renders every Twig page entry under `staticDir` to an HTML file in `outDir`.
     *
     * Throws if `isBuild && useViteAssetsInBuild` is true but the Vite manifest
     * assets could not be loaded (indicating the JS/CSS build step was skipped).
     */
    async function renderTwigPages(context: RenderContext): Promise<void> {
        const { isBuild, useViteDevServer, viteDevBase } = context;
        registerTwigFilters();

        const staticRoot = path.join(projectRoot, staticDir);
        const templatesRoot = path.join(projectRoot, templatesDir);
        const translationsRoot = path.join(projectRoot, translationsDir);

        const globalVars = await loadJson(path.join(translationsRoot, 'global.json'));
        const slugMap = slugMapPath
            ? (await loadJson(path.join(projectRoot, slugMapPath))) as SlugMap
            : null;
        const viteAssets = await loadViteAssets();
        if (isBuild && useViteAssetsInBuild && (!viteAssets.js || !viteAssets.css)) {
            throw new Error('Vite manifest assets are required for production Twig rendering.');
        }

        const allFiles = await walkFiles(staticRoot);
        const pages = allFiles.filter((filePath) => {
            const ext = path.extname(filePath).toLowerCase();
            const basename = path.basename(filePath);
            return ext === '.twig' && !basename.startsWith('_');
        });

        for (const pagePath of pages) {
            const lang = detectLanguage(pagePath);
            const translations = await loadJson(path.join(translationsRoot, `${lang}.json`));
            const assetPath = calculateAssetPath(pagePath, staticRoot, outDir);
            const outputRelative = path.relative(staticRoot, pagePath).replace(/\.twig$/, '.html');
            const outputPath = path.join(outDir, outputRelative);

            const langSwitcherUrls = slugMap
                ? buildLangSwitcherUrls(outputRelative, lang, slugMap, assetPath)
                : {};

            const data: Record<string, unknown> = {
                ...globalVars,
                ...translations,
                locale: lang,
                assetPath,
                langSwitcherUrls,
                isProduction: isBuild,
                useViteDevServer,
                viteDevBase,
                useViteAssets: isBuild && useViteAssetsInBuild,
                viteAssets
            };

            const pageDir = path.dirname(pagePath);
            const relativeTplsPath = path.relative(pageDir, templatesRoot).split(path.sep).join('/');
            const templateContent = (await fs.promises.readFile(pagePath, 'utf8')).replace(
                /(\{%\s*(?:extends|include|embed|import|from)\s+['"])([^'"]+?\.twig)(['"])/g,
                (fullMatch, prefix: string, targetPath: string, suffix: string) => {
                    if (targetPath.startsWith('.') || targetPath.startsWith('/')) {
                        return fullMatch;
                    }
                    return `${prefix}${relativeTplsPath}/${targetPath}${suffix}`;
                }
            );

            const compiled = Twig.twig({
                data: templateContent,
                path: pagePath,
                base: templatesRoot,
                rethrow: true
            });

            const html = compiled
                .render(data)
                .split('\n')
                .filter((line) => line.trim() !== '')
                .join('\n');

            await ensureDir(path.dirname(outputPath));
            await fs.promises.writeFile(outputPath, `${html}\n`, 'utf8');
        }
    }

    return {
        renderTwigPages
    };
}

export { createTwigPagesTask };
