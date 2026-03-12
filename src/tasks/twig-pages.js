import fs from 'fs';
import path from 'path';
import Twig from 'twig';

/**
 * Creates a task that renders Twig page templates into static HTML files.
 *
 * Each `.twig` file under `staticDir` (excluding underscore-prefixed files)
 * is treated as a page entry. Language is inferred from the directory structure,
 * translations are loaded per language, and asset paths are made relative to
 * each output file's location.
 *
 * @param {object}   options
 * @param {string}   options.srcDir               - Root source directory.
 * @param {string}   options.staticDir            - Directory containing Twig page entries.
 * @param {string}   options.templatesDir         - Shared Twig templates directory.
 * @param {string}   options.translationsDir      - Directory containing JSON translation files.
 * @param {string}   [options.slugMapPath]        - Project-relative path to the URL slug translation map (JSON).
 * @param {boolean}  options.useViteAssetsInBuild - Whether to inject Vite manifest assets.
 * @param {string[]} [options.locales]            - List of locale codes to detect from directory names. Defaults to `['fr','en','nl','de']`.
 * @param {string}   [options.defaultLocale]      - Locale used when none is detected from the path. Defaults to `'fr'`.
 * @param {string}   [options.scriptsEntryKey]    - Vite manifest key for the JS entry point. Defaults to `'src/js/scripts.js'`.
 * @param {string}   options.projectRoot          - Absolute project root path.
 * @param {string}   options.outDir               - Absolute output directory path.
 * @param {Function} options.walkFiles            - Async function to list files recursively.
 * @param {Function} options.ensureDir            - Async function to create a directory tree.
 * @param {Function} options.loadJson             - Async function to load a JSON file safely.
 * @param {Array<{name:string, fn:Function}>} [options.filters=[]] - Additional Twig filters to register alongside the built-ins.
 * @returns {{ renderTwigPages: Function }}
 */
function createTwigPagesTask(options) {
    const {
        srcDir,
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
     *
     * @param {string} filePath - Absolute or relative path to the Twig file.
     * @returns {string}
     */
    function detectLanguage(filePath) {
        const match = filePath.match(localePattern);
        return match ? match[1] : defaultLocale;
    }

    /**
     * Calculates the relative path prefix needed to reach the asset root from
     * the output HTML file's location (e.g. `'../../'` for a file two levels deep).
     * Returns an empty string for files at the root of the output directory.
     *
     * @param {string} filePath    - Absolute path to the source `.twig` file.
     * @param {string} staticRoot  - Absolute path to the static pages root.
     * @param {string} outputRoot  - Absolute path to the build output directory.
     * @returns {string} Relative prefix ending with `/`, or empty string.
     */
    function calculateAssetPath(filePath, staticRoot, outputRoot) {
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
     * For example, for `de/unbefristete-kombinierte-erlaubnis.html` it returns:
     * ```
     * {
     *   nl: '../nl/gecombineerde-vergunning-onbepaalde-duur.html',
     *   fr: '../fr/permis-unique-a-duree-illimitee.html',
     *   en: '../en/permanent-single-permit.html'
     * }
     * ```
     *
     * Returns an empty object when the page has no translatable lang prefix or
     * when any slug cannot be found in the map.
     *
     * @param {string} outputRelative - Relative output path, e.g. `de/page.html`.
     * @param {string} lang           - Current page locale, e.g. `'de'`.
     * @param {object} slugMap        - Parsed slug translation map (translations.json).
     * @param {string} assetPath      - Relative prefix back to the output root (e.g. `'../'`).
     * @returns {Record<string, string>}
     */
    function buildLangSwitcherUrls(outputRelative, lang, slugMap, assetPath) {
        const normalized = outputRelative.split(path.sep).join('/');
        const langPrefix = `${lang}/`;

        if (!normalized.startsWith(langPrefix) || !slugMap?.[lang]) return {};

        const slugs = normalized
            .slice(langPrefix.length)
            .replace(/\.html$/, '')
            .split('/')
            .filter(Boolean);

        const indices = slugs.map(slug => slugMap[lang].indexOf(slug));
        if (indices.some(i => i === -1)) return {};

        const urls = {};
        for (const targetLang of Object.keys(slugMap)) {
            if (targetLang === lang || !slugMap[targetLang]) continue;

            const translatedSlugs = indices.map(i => slugMap[targetLang][i]);
            if (translatedSlugs.some(s => !s)) continue;

            urls[targetLang] = `${assetPath}${targetLang}/${translatedSlugs.join('/')}.html`;
        }

        return urls;
    }

    /**
     * Resolves a Vite manifest entry by trying `preferredKeys` first, then
     * falling back to a predicate scan of all entries. Returns `undefined` if
     * nothing matches.
     *
     * @param {object}   manifest         - Parsed `.vite/manifest.json`.
     * @param {string[]} preferredKeys    - Manifest keys to check in order of preference.
     * @param {Function} fallbackMatcher  - `(key, value) => boolean` used when no preferred key matches.
     * @returns {object|undefined} The matched manifest entry, or `undefined`.
     */
    function getViteManifestEntry(manifest, preferredKeys, fallbackMatcher) {
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
     * Returns `{ js: '', css: '' }` when the manifest does not exist (dev mode).
     *
     * @returns {Promise<{ js: string, css: string }>}
     */
    async function loadViteAssets() {
        const manifestPath = path.join(outDir, '.vite', 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            return {};
        }

        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        const entryBasename = path.basename(scriptsEntryKey);
        const entryStem = path.basename(scriptsEntryKey, path.extname(scriptsEntryKey));
        const scriptsEntry = getViteManifestEntry(
            manifest,
            [scriptsEntryKey, entryStem],
            (key, value) => key.endsWith(entryBasename) || String(value?.file || '').includes(entryStem)
        );

        return {
            js: scriptsEntry?.file || '',
            css: scriptsEntry?.css?.[0] || ''
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
    function registerTwigFilters() {
        Twig.extendFilter('external_links', function(value, lang = 'fr') {
            if (!value || typeof value !== 'string') return value;

            const externalLabels = {
                fr: 'Nouvelle fenêtre',
                nl: 'Nieuw venster',
                de: 'neues Fenster',
                en: 'New window'
            };

            const fileExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'pptx', 'zip'];
            const label = externalLabels[lang] || externalLabels.fr;

            return value.replace(/<a([^>]*)>(.*?)<\/a>/gis, (match, attrs, text) => {
                const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
                if (!hrefMatch) return match;

                const href = hrefMatch[1];
                if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
                    return match;
                }

                const ext = href.split('?')[0].split('.').pop().toLowerCase();
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

        Twig.extendFilter('entity_encode', function(value) {
            if (!value || typeof value !== 'string') return value;

            const encode = (str) =>
                str
                    .split('')
                    .map((char) => `&#${char.charCodeAt(0)};`)
                    .join('');

            return value.replace(
                /<a\s([^>]*)>(.*?)<\/a>/gis,
                (match, attrs, text) => {
                    const hrefMatch = attrs.match(/href\s*=\s*["']((?:mailto|tel):[^"']+)["']/i);
                    if (!hrefMatch) return match;

                    const encodedAttrs = attrs.replace(
                        /(href\s*=\s*["'])(?:mailto|tel):[^"']+(?=["'])/i,
                        (_, prefix) => prefix + encode(hrefMatch[1])
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
     * For each page the function:
     * 1. Detects the locale from the file path and loads the matching translations.
     * 2. Computes relative asset/template paths so the file works at any nesting depth.
     * 3. Rewrites bare template references (e.g. `extends 'layout.twig'`) to
     *    paths relative to the page file, since Twig requires resolvable paths.
     * 4. Compiles and renders the template, strips blank lines, and writes the result.
     *
     * Throws if `isBuild && useViteAssetsInBuild` is true but the Vite manifest
     * assets could not be loaded (indicating the JS/CSS build step was skipped).
     *
     * @param {{ isBuild: boolean, useViteDevServer: boolean, viteDevBase: string }} context
     * @returns {Promise<void>}
     */
    async function renderTwigPages(context) {
        const { isBuild, useViteDevServer, viteDevBase } = context;
        registerTwigFilters();

        const staticRoot = path.join(projectRoot, staticDir);
        const templatesRoot = path.join(projectRoot, templatesDir);
        const translationsRoot = path.join(projectRoot, translationsDir);

        const globalVars = await loadJson(path.join(translationsRoot, 'global.json'));
        const slugMap = slugMapPath ? await loadJson(path.join(projectRoot, slugMapPath)) : null;
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

            const data = {
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
                (fullMatch, prefix, targetPath, suffix) => {
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
