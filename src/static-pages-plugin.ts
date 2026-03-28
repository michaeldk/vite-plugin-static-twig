import path from 'path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { createSiteUtils } from './site-utils.js';
import { createTwigPagesTask } from './tasks/twig-pages.js';
import { createDistUrlRewrite } from './middleware/dist-url-rewrite.js';
import { collectStaticPagesWatchPaths } from './static-pages-watch-paths.js';
import type { TwigFilter, RenderContext } from './tasks/twig-pages.js';

export interface StaticPagesPluginOptions {
    /** Root source directory. @default 'src' */
    srcDir?: string;
    /** Directory containing Twig page entry files. Files prefixed with `_` are skipped. @default 'src/templates/pages' */
    staticDir?: string;
    /** Shared Twig templates directory (layouts, partials, macros). @default 'src/templates' */
    templatesDir?: string;
    /** Directory containing JSON translation files. @default 'src/translations' */
    translationsDir?: string;
    /** Project-relative path to the JSON slug translation map. Set to `null` to disable. @default 'src/js/json/translations.json' */
    slugMapPath?: string | null;
    /** When `true`, reads the Vite manifest and injects hashed JS/CSS paths into every rendered page. @default true */
    useViteAssetsInBuild?: boolean;
    /** Locale codes recognised in directory names. Pass `[]` for non-localised sites. @default ['fr','en','nl','de'] */
    locales?: string[];
    /** Fallback locale used when none of the `locales` are found in the file path. @default 'fr' */
    defaultLocale?: string;
    /** The Vite manifest key for the JS entry point. @default 'src/js/scripts.js' */
    scriptsEntryKey?: string;
    /** Additional Twig filters to register alongside the built-ins. Each entry is `{ name, fn }`. @default [] */
    filters?: TwigFilter[];
    /**
     * Delay (ms) before running Twig re-render after `hotUpdate`. Chained updates within this
     * window collapse to a single render + full reload (filesystems often emit duplicate events
     * per save). Set to `0` to disable. @default 50
     */
    hotUpdateDebounceMs?: number;
}

interface Tasks {
    utils: ReturnType<typeof createSiteUtils>;
    twigPagesTask: ReturnType<typeof createTwigPagesTask>;
}

/**
 * Vite plugin that renders Twig templates into static HTML pages during both
 * development (via a dev-server middleware) and production builds.
 *
 * In dev mode the plugin watches the source directories and triggers a full
 * browser reload whenever a relevant file changes, using a render-coalescing
 * strategy to avoid concurrent renders.
 */
function staticPagesPlugin(options: StaticPagesPluginOptions = {}): Plugin {
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
        filters = [],
        hotUpdateDebounceMs = 50
    } = options;

    let config: ResolvedConfig;
    let projectRoot: string;
    let devServer: ViteDevServer | null = null;
    let tasks: Tasks | null = null;

    // Render coalescing: if a file changes while a render is already running,
    // we don't start a second concurrent render. Instead we set rerenderQueued=true
    // so the active render loops once more when done, draining all pending requests.
    let isRendering = false;
    let rerenderQueued = false;
    let fullReloadQueued = false;
    let hotUpdateDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Instantiates the utility helpers and the Twig render task, bound to the
     * resolved Vite config. Called once inside `configResolved`.
     */
    function buildTasks(): Tasks {
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

        return { utils, twigPagesTask };
    }

    /**
     * Returns true if `absPath` is inside any of the three watched source
     * directories (static pages, templates, or translations).
     */
    function isInWatchedDirectory(absPath: string): boolean {
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
     */
    async function addWatchFiles(ctx: { addWatchFile: (id: string) => void }): Promise<void> {
        const paths = await collectStaticPagesWatchPaths({
            projectRoot,
            staticDir,
            templatesDir,
            translationsDir,
            slugMapPath,
            walkFiles: tasks!.utils.walkFiles
        });
        for (const filePath of paths) {
            ctx.addWatchFile(filePath);
        }
    }

    /**
     * Builds the context object passed to `twigPagesTask.renderTwigPages`,
     * derived from the current Vite command (`serve` vs `build`).
     */
    function createRenderContext(): RenderContext {
        return {
            isBuild: config.command === 'build',
            useViteDevServer: config.command === 'serve',
            viteDevBase: '/'
        };
    }

    /**
     * Triggers a Twig re-render. Calls made while a render is already in progress
     * are coalesced — the render loop processes them in sequence, never in parallel.
     */
    async function renderTwigPages(fullReload = false): Promise<void> {
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

                await tasks!.twigPagesTask.renderTwigPages(createRenderContext());
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
     */
    function needsRerender(filePath: string): boolean {
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
            await tasks!.twigPagesTask.renderTwigPages(createRenderContext());
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
            return () => {
                if (hotUpdateDebounceTimer !== null) {
                    clearTimeout(hotUpdateDebounceTimer);
                    hotUpdateDebounceTimer = null;
                }
            };
        },
        hotUpdate({ file }) {
            if (!needsRerender(file)) {
                return undefined;
            }
            // Fire-and-forget: hotUpdate must return synchronously, so we do not await.
            // Return empty array to suppress default HMR; renderTwigPages sends full-reload.
            if (hotUpdateDebounceMs <= 0) {
                void renderTwigPages(true);
                return [];
            }
            if (hotUpdateDebounceTimer !== null) {
                clearTimeout(hotUpdateDebounceTimer);
            }
            hotUpdateDebounceTimer = setTimeout(() => {
                hotUpdateDebounceTimer = null;
                void renderTwigPages(true);
            }, hotUpdateDebounceMs);
            return [];
        }
    };
}

export default staticPagesPlugin;
