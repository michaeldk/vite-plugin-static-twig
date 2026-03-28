import path from 'path';
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
};

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
});
