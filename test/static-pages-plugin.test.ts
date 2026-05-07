import path from 'path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import type { PluginContext } from 'rollup';
import type { ResolvedConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import { createSiteUtils } from '../src/site-utils.js';
import { collectStaticPagesWatchPaths } from '../src/static-pages-watch-paths.js';
import staticPagesPlugin from '../src/static-pages-plugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const twigMinimalFixtureRoot = path.join(__dirname, 'fixtures', 'twig-minimal');

function createServeConfig(root: string): ResolvedConfig {
    return {
        command: 'serve',
        root,
        build: { outDir: 'dist' }
    } as ResolvedConfig;
}

/** Vite types plugin hooks as `ObjectHook` (function or `{ handler }`); the implementation is plain functions. */
type StaticPagesPluginHookSurface = {
    configResolved(config: ResolvedConfig): void;
    buildStart(this: PluginContext): Promise<void>;
    configureServer(server: FakeDevServer): Promise<() => void>;
    hotUpdate(ctx: { file: string }): [] | undefined;
};

interface FakeDevServer {
    watcher: {
        add(id: string | string[]): void;
        on(eventName: string, listener: (...args: string[]) => void): void;
        off(eventName: string, listener: (...args: string[]) => void): void;
    };
    middlewares: {
        use(middleware: unknown): void;
    };
    ws: {
        sent: unknown[];
        send(message: unknown): void;
    };
}

async function waitFor(assertion: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await assertion()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for assertion.');
}

function createFakeDevServer(): FakeDevServer {
    return {
        watcher: {
            add(): void {},
            on(): void {},
            off(): void {}
        },
        middlewares: {
            use(): void {}
        },
        ws: {
            sent: [],
            send(message: unknown): void {
                this.sent.push(message);
            }
        }
    };
}

describe('staticPagesPlugin / addWatchFile deduplication', () => {
    it('registers each watched path at most once when staticDir is under templatesDir', async () => {
        const watchOptions = {
            staticDir: 'src/templates/pages',
            templatesDir: 'src/templates',
            translationsDir: 'src/translations',
            slugMapPath: null as string | null
        };

        const plugin = staticPagesPlugin({
            useViteAssetsInBuild: false,
            slugMapPath: watchOptions.slugMapPath
        }) as unknown as StaticPagesPluginHookSurface;

        plugin.configResolved(createServeConfig(twigMinimalFixtureRoot));

        const watched: string[] = [];
        const ctx = {
            addWatchFile(id: string): void {
                watched.push(path.resolve(id));
            }
        } as PluginContext;

        await plugin.buildStart.call(ctx);

        const counts = new Map<string, number>();
        for (const p of watched) {
            counts.set(p, (counts.get(p) ?? 0) + 1);
        }
        const duplicates = [...counts.entries()].filter(([, n]) => n > 1);
        expect(duplicates).toEqual([]);

        const { walkFiles } = createSiteUtils(twigMinimalFixtureRoot);
        const expectedPaths = await collectStaticPagesWatchPaths({
            projectRoot: twigMinimalFixtureRoot,
            ...watchOptions,
            walkFiles
        });
        expect([...watched].sort()).toEqual([...expectedPaths.map((p) => path.resolve(p))].sort());
    });

    it('re-renders from hotUpdate for existing shared Twig templates', async () => {
        const tmpRoot = await mkdtemp(path.join(tmpdir(), 'static-pages-plugin-'));
        try {
            const pagesDir = path.join(tmpRoot, 'src', 'templates', 'pages', 'fr');
            const templatesDir = path.join(tmpRoot, 'src', 'templates');
            const translationsDir = path.join(tmpRoot, 'src', 'translations');
            await mkdir(pagesDir, { recursive: true });
            await mkdir(translationsDir, { recursive: true });
            await writeFile(path.join(translationsDir, 'global.json'), '{}');
            await writeFile(path.join(translationsDir, 'fr.json'), '{}');
            await writeFile(path.join(templatesDir, '_base.twig'), "{% include '_footer.twig' %}{% block body %}{% endblock %}");
            await writeFile(path.join(templatesDir, '_footer.twig'), '<footer>Initial footer</footer>');
            await writeFile(path.join(pagesDir, 'index.twig'), "{% extends '_base.twig' %}{% block body %}Body{% endblock %}");

            const plugin = staticPagesPlugin({
                useViteAssetsInBuild: false,
                slugMapPath: null,
                hotUpdateDebounceMs: 0
            }) as unknown as StaticPagesPluginHookSurface;
            plugin.configResolved(createServeConfig(tmpRoot));
            const server = createFakeDevServer();
            const cleanup = await plugin.configureServer(server);
            const htmlPath = path.join(tmpRoot, 'dist', 'fr', 'index.html');
            expect(await readFile(htmlPath, 'utf8')).toContain('Initial footer');

            await writeFile(path.join(templatesDir, '_footer.twig'), '<footer>Updated footer</footer>');
            expect(plugin.hotUpdate({ file: path.join(templatesDir, '_footer.twig') })).toEqual([]);

            await waitFor(async () => (await readFile(htmlPath, 'utf8')).includes('Updated footer'));
            expect(await readFile(htmlPath, 'utf8')).not.toContain('Initial footer');
            expect(server.ws.sent).toContainEqual({ type: 'full-reload' });
            cleanup();
        } finally {
            await rm(tmpRoot, { recursive: true, force: true });
        }
    });
});
