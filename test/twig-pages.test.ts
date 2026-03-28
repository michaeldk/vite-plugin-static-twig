import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSiteUtils } from '../src/site-utils.js';
import { createTwigPagesTask } from '../src/tasks/twig-pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const twigMinimalFixtureRoot = path.join(__dirname, '..', 'test', 'fixtures', 'twig-minimal');

describe('createTwigPagesTask / renderTwigPages', () => {
    let tmpRoot: string;
    let outDir: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(path.join(tmpdir(), 'twig-pages-'));
        outDir = path.join(tmpRoot, 'dist');
        await mkdir(outDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    it('renders fixture pages, applies external_links without touching <article>, and runs custom filters', async () => {
        const { walkFiles, ensureDir, loadJson } = createSiteUtils(twigMinimalFixtureRoot);

        const { renderTwigPages } = createTwigPagesTask({
            srcDir: 'src',
            staticDir: 'src/templates/pages',
            templatesDir: 'src/templates',
            translationsDir: 'src/translations',
            useViteAssetsInBuild: false,
            projectRoot: twigMinimalFixtureRoot,
            outDir,
            walkFiles,
            ensureDir,
            loadJson,
            filters: [
                {
                    name: 'shout',
                    fn: (value: unknown) => (typeof value === 'string' ? value.toUpperCase() : value)
                }
            ]
        });

        await renderTwigPages({
            isBuild: false,
            useViteDevServer: true,
            viteDevBase: '/'
        });

        const htmlPath = path.join(outDir, 'fr', 'filters.html');
        const html = await readFile(htmlPath, 'utf8');

        expect(html).toContain('<article class="regression">Article body</article>');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('PLUGIN');

        expect(html).not.toMatch(/<article[^>]*target="_blank"/);
    });

    it('throws when production build expects Vite manifest assets but manifest is missing', async () => {
        const { walkFiles, ensureDir, loadJson } = createSiteUtils(twigMinimalFixtureRoot);

        const { renderTwigPages } = createTwigPagesTask({
            srcDir: 'src',
            staticDir: 'src/templates/pages',
            templatesDir: 'src/templates',
            translationsDir: 'src/translations',
            useViteAssetsInBuild: true,
            projectRoot: twigMinimalFixtureRoot,
            outDir,
            walkFiles,
            ensureDir,
            loadJson
        });

        await expect(
            renderTwigPages({
                isBuild: true,
                useViteDevServer: false,
                viteDevBase: '/'
            })
        ).rejects.toThrow(/Vite manifest assets are required/);
    });

    it('succeeds in production when useViteAssetsInBuild is false', async () => {
        const { walkFiles, ensureDir, loadJson } = createSiteUtils(twigMinimalFixtureRoot);

        const { renderTwigPages } = createTwigPagesTask({
            srcDir: 'src',
            staticDir: 'src/templates/pages',
            templatesDir: 'src/templates',
            translationsDir: 'src/translations',
            useViteAssetsInBuild: false,
            projectRoot: twigMinimalFixtureRoot,
            outDir,
            walkFiles,
            ensureDir,
            loadJson
        });

        await expect(
            renderTwigPages({
                isBuild: true,
                useViteDevServer: false,
                viteDevBase: '/'
            })
        ).resolves.toBeUndefined();
    });

    it('loads hashed assets from .vite/manifest.json when present', async () => {
        await mkdir(path.join(outDir, '.vite'), { recursive: true });
        await writeFile(
            path.join(outDir, '.vite', 'manifest.json'),
            JSON.stringify({
                'src/js/scripts.js': {
                    file: 'assets/main-abc123.js',
                    css: ['assets/main-def456.css']
                }
            })
        );

        const { walkFiles, ensureDir, loadJson } = createSiteUtils(twigMinimalFixtureRoot);

        const { renderTwigPages } = createTwigPagesTask({
            srcDir: 'src',
            staticDir: 'src/templates/pages',
            templatesDir: 'src/templates',
            translationsDir: 'src/translations',
            useViteAssetsInBuild: true,
            scriptsEntryKey: 'src/js/scripts.js',
            projectRoot: twigMinimalFixtureRoot,
            outDir,
            walkFiles,
            ensureDir,
            loadJson
        });

        await renderTwigPages({
            isBuild: true,
            useViteDevServer: false,
            viteDevBase: '/'
        });

        const htmlPath = path.join(outDir, 'fr', 'vite-check.html');
        const html = await readFile(htmlPath, 'utf8');
        expect(html).toContain('assets/main-abc123.js');
        expect(html).toContain('assets/main-def456.css');
    });
});
