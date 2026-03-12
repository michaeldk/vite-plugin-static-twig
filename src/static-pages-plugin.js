import path from 'path';
import { createSiteUtils } from './site-utils.js';
import { createTwigPagesTask } from './tasks/twig-pages.js';
import { createDistUrlRewrite } from './middleware/dist-url-rewrite.js';

/**
 * Vite plugin that renders Twig templates into static HTML pages during both
 * development (via a dev-server middleware) and production builds.
 *
 * In dev mode the plugin watches the source directories and triggers a full
 * browser reload whenever a relevant file changes, using a render-coalescing
 * strategy to avoid concurrent renders.
 *
 * @param {object}   [options]
 * @param {string}   [options.srcDir='src']                                  - Root source directory.
 * @param {string}   [options.staticDir='src/templates/pages']               - Twig page entry files.
 * @param {string}   [options.templatesDir='src/templates']                  - Shared Twig templates.
 * @param {string}   [options.translationsDir='src/translations']            - JSON translation files.
 * @param {string}   [options.slugMapPath='src/js/json/translations.json']   - URL slug translation map used to build lang-switcher hrefs at build time.
 * @param {boolean}  [options.useViteAssetsInBuild=true]                     - Inject Vite manifest assets into rendered HTML.
 * @param {string[]} [options.locales=['fr','en','nl','de']]                  - Locale codes to detect from directory names.
 * @param {string}   [options.defaultLocale='fr']                            - Fallback locale when none is detected from the path.
 * @param {string}   [options.scriptsEntryKey='src/js/scripts.js']           - Vite manifest key for the JS/CSS entry point.
 * @param {Array<{name:string, fn:Function}>} [options.filters=[]]          - Additional Twig filters to register. Each entry is `{ name, fn }` passed directly to `Twig.extendFilter`.
 * @returns {import('vite').Plugin}
 */
function staticPagesPlugin(options = {}) {
    const {
        srcDir = 'src',
        staticDir = 'src/templates/pages',
        templatesDir = 'src/templates',
        translationsDir = 'src/translations',
        slugMapPath = 'src/js/json/translations.json',
        useViteAssetsInBuild = true,
        locales = ['fr', 'en', 'nl', 'de'],
        defaultLocale = 'fr',
        scriptsEntryKey = 'src/js/scripts.js',
        filters = []
    } = options;

    let config;
    let projectRoot;
    let devServer = null;
    let tasks = null;

    // Render coalescing: if a file changes while a render is already running,
    // we don't start a second concurrent render. Instead we set rerenderQueued=true
    // so the active render loops once more when done, draining all pending requests.
    let isRendering = false;
    let rerenderQueued = false;
    let fullReloadQueued = false;

    /**
     * Instantiates the utility helpers and the Twig render task, bound to the
     * resolved Vite config. Called once inside `configResolved`.
     *
     * @returns {{ utils: object, twigPagesTask: object }}
     */
    function buildTasks() {
        const utils = createSiteUtils(projectRoot);
        const twigPagesTask = createTwigPagesTask({
            srcDir,
            staticDir,
            templatesDir,
            translationsDir,
            slugMapPath,
            useViteAssetsInBuild,
            locales,
            defaultLocale,
            scriptsEntryKey,
            filters,
            projectRoot,
            outDir: path.resolve(projectRoot, config.build.outDir),
            walkFiles: utils.walkFiles,
            ensureDir: utils.ensureDir,
            loadJson: utils.loadJson
        });

        return {
            utils,
            twigPagesTask
        };
    }

    /**
     * Returns true if `absPath` is inside any of the three watched source
     * directories (static pages, templates, or translations).
     * Does **not** filter by file extension.
     *
     * @param {string} absPath - Absolute path to check.
     * @returns {boolean}
     */
    function isInWatchedDirectory(absPath) {
        const relativePath = path.relative(projectRoot, absPath);
        if (relativePath.startsWith('..')) {
            return false;
        }

        const staticPrefix = `${staticDir}${path.sep}`;
        const templatesPrefix = `${templatesDir}${path.sep}`;
        const translationsPrefix = `${translationsDir}${path.sep}`;

        return (
            relativePath === staticDir ||
            relativePath === templatesDir ||
            relativePath === translationsDir ||
            relativePath.startsWith(staticPrefix) ||
            relativePath.startsWith(templatesPrefix) ||
            relativePath.startsWith(translationsPrefix)
        );
    }

    /**
     * Registers every source file in the watched directories with Vite's watcher
     * so that `hotUpdate` is triggered when they change. Only called in dev mode.
     *
     * @param {import('vite').BuildContext} ctx - The Vite `buildStart` hook context.
     * @returns {Promise<void>}
     */
    async function addWatchFiles(ctx) {
        const staticRoot = path.join(projectRoot, staticDir);
        const templatesRoot = path.join(projectRoot, templatesDir);
        const translationsRoot = path.join(projectRoot, translationsDir);

        const [staticFiles, templateFiles, translationFiles] = await Promise.all([
            tasks.utils.walkFiles(staticRoot),
            tasks.utils.walkFiles(templatesRoot),
            tasks.utils.walkFiles(translationsRoot)
        ]);

        const twigFiles = staticFiles.filter((filePath) => path.extname(filePath).toLowerCase() === '.twig');
        const extraFiles = slugMapPath ? [path.resolve(projectRoot, slugMapPath)] : [];
        for (const filePath of [...twigFiles, ...templateFiles, ...translationFiles, ...extraFiles]) {
            ctx.addWatchFile(filePath);
        }
    }

    /**
     * Builds the context object passed to `twigPagesTask.renderTwigPages`,
     * derived from the current Vite command (`serve` vs `build`).
     *
     * @returns {{ isBuild: boolean, useViteDevServer: boolean, viteDevBase: string }}
     */
    function createRenderContext() {
        return {
            isBuild: config.command === 'build',
            useViteDevServer: config.command === 'serve',
            viteDevBase: '/'
        };
    }

    /**
     * Triggers a Twig re-render. Calls made while a render is already in progress
     * are coalesced — the render loop processes them in sequence, never in parallel.
     * @param {boolean} fullReload - Whether to send a full browser reload after rendering.
     */
    async function renderTwigPages(fullReload = false) {
        rerenderQueued = true;
        fullReloadQueued ||= fullReload;
        if (isRendering) {
            return;
        }

        isRendering = true;
        try {
            while (rerenderQueued) {
                const shouldReload = fullReloadQueued;
                rerenderQueued = false;
                fullReloadQueued = false;

                await tasks.twigPagesTask.renderTwigPages(createRenderContext());
                if (shouldReload && devServer) {
                    devServer.ws.send({ type: 'full-reload' });
                }
            }
        } catch (error) {
            console.error('[static-pages-plugin] render failed:', error);
        } finally {
            isRendering = false;
        }
    }

    /**
     * Determines whether a changed file should trigger a full Twig re-render.
     *
     * Returns `true` when the file is:
     * - a `.twig` file inside any watched directory, OR
     * - any file inside the templates or translations directories (changing a
     *   layout or a translation string always invalidates every page).
     *
     * Returns `false` for paths outside the watched directories or for unrelated
     * file types (e.g. static images inside the pages tree).
     *
     * @param {string} filePath - Absolute or project-relative path of the changed file.
     * @returns {boolean}
     */
    function needsRerender(filePath) {
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);

        if (slugMapPath && absolutePath === path.resolve(projectRoot, slugMapPath)) {
            return true;
        }

        if (!isInWatchedDirectory(absolutePath)) {
            return false;
        }

        const relativePath = path.relative(projectRoot, absolutePath);
        const extension = path.extname(relativePath).toLowerCase();
        const isTwig = extension === '.twig';
        const templatesPrefix = `${templatesDir}${path.sep}`;
        const translationsPrefix = `${translationsDir}${path.sep}`;
        const isTemplateOrTranslation =
            relativePath === templatesDir ||
            relativePath === translationsDir ||
            relativePath.startsWith(templatesPrefix) ||
            relativePath.startsWith(translationsPrefix);

        return isTwig || isTemplateOrTranslation;
    }

    return {
        name: 'static-pages-plugin',
        configResolved(resolvedConfig) {
            config = resolvedConfig;
            projectRoot = resolvedConfig.root;
            tasks = buildTasks();
        },
        async buildStart() {
            // Only register watch files in dev mode; build mode does not need them.
            if (config.command === 'serve') {
                await addWatchFiles(this);
            }
        },
        async closeBundle() {
            await tasks.twigPagesTask.renderTwigPages(createRenderContext());
            console.log('Twig pages generated in output directory.');
        },
        async configureServer(server) {
            devServer = server;
            await renderTwigPages(false);
            server.middlewares.use(
                createDistUrlRewrite({
                    projectRoot,
                    outDir: path.resolve(projectRoot, config.build.outDir),
                    watcher: server.watcher
                })
            );
        },
        hotUpdate({ file }) {
            if (needsRerender(file)) {
                // Fire-and-forget: hotUpdate must return synchronously, so we do not
                // await. The render coalescing logic handles concurrent calls safely.
                // Return empty array to suppress default HMR; renderTwigPages sends
                // a full-reload itself once re-rendering is complete.
                void renderTwigPages(true);
                return [];
            }
        }
    };
}

export default staticPagesPlugin;
