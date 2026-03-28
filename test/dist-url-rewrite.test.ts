import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import type { ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDistUrlRewrite } from '../src/middleware/dist-url-rewrite.js';

function createMockReq(overrides: Partial<IncomingMessage> & { url?: string; method?: string }): IncomingMessage {
    return {
        url: '/',
        method: 'GET',
        ...overrides
    } as IncomingMessage;
}

function createStubWatcher(): ViteDevServer['watcher'] {
    return { on: vi.fn() } as unknown as ViteDevServer['watcher'];
}

describe('createDistUrlRewrite', () => {
    let projectRoot: string;
    let outDir: string;

    beforeEach(async () => {
        projectRoot = await mkdtemp(path.join(tmpdir(), 'dist-rewrite-root-'));
        outDir = path.join(projectRoot, 'dist');
        await mkdir(outDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(projectRoot, { recursive: true, force: true });
    });

    it('rewrites GET requests to an existing .html file under outDir', async () => {
        await mkdir(path.join(outDir, 'fr'), { recursive: true });
        await writeFile(path.join(outDir, 'fr', 'about.html'), '<html></html>', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/fr/about', method: 'GET' });
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe('/dist/fr/about.html');
        expect(next).toHaveBeenCalledOnce();
    });

    it('rewrites HEAD requests the same way as GET', async () => {
        await mkdir(path.join(outDir, 'en'), { recursive: true });
        await writeFile(path.join(outDir, 'en', 'page.html'), 'x', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/en/page', method: 'HEAD' });
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe('/dist/en/page.html');
        expect(next).toHaveBeenCalledOnce();
    });

    it('resolves root path to index.html', async () => {
        await writeFile(path.join(outDir, 'index.html'), '<html></html>', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/', method: 'GET' });
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe('/dist/index.html');
        expect(next).toHaveBeenCalledOnce();
    });

    it('preserves query string when rewriting', async () => {
        await mkdir(path.join(outDir, 'a'), { recursive: true });
        await writeFile(path.join(outDir, 'a', 'b.html'), 'x', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/a/b?x=1&y=2', method: 'GET' });
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe('/dist/a/b.html?x=1&y=2');
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not rewrite when no candidate file exists', async () => {
        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/missing', method: 'GET' });
        const originalUrl = req.url;
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe(originalUrl);
        expect(next).toHaveBeenCalledOnce();
    });

    it('bypasses Vite-internal and source paths without rewriting', async () => {
        await writeFile(path.join(outDir, 'index.html'), 'x', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const bypassUrls = ['/@vite/client', '/@fs/foo', '/@id/xxx', '/__vite_ping', '/node_modules/x', '/src/main.ts'];

        for (const url of bypassUrls) {
            const req = createMockReq({ url, method: 'GET' });
            const before = req.url;
            const next = vi.fn();
            await middleware(req, {} as ServerResponse, next);
            expect(req.url, url).toBe(before);
            expect(next).toHaveBeenCalledOnce();
        }
    });

    it('bypasses paths already under the dist public base', async () => {
        await writeFile(path.join(outDir, 'inside.html'), 'x', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/dist/inside.html', method: 'GET' });
        const before = req.url;
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe(before);
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not rewrite non-GET/HEAD methods', async () => {
        await writeFile(path.join(outDir, 'index.html'), 'x', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/', method: 'POST' });
        const before = req.url;
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe(before);
        expect(next).toHaveBeenCalledOnce();
    });

    it('does not rewrite when req.url is missing', async () => {
        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = { method: 'GET' } as IncomingMessage;
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(next).toHaveBeenCalledOnce();
    });

    it('serves nested index.html for trailing-slash paths', async () => {
        await mkdir(path.join(outDir, 'docs', 'api'), { recursive: true });
        await writeFile(path.join(outDir, 'docs', 'api', 'index.html'), 'nested', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot,
            outDir,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/docs/api/', method: 'GET' });
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe('/dist/docs/api/index.html');
        expect(next).toHaveBeenCalledOnce();
    });

    it('when outDir equals projectRoot, uses / as dist base', async () => {
        const flatRoot = await mkdtemp(path.join(tmpdir(), 'dist-flat-'));
        await writeFile(path.join(flatRoot, 'plain.html'), 'ok', 'utf8');

        const middleware = createDistUrlRewrite({
            projectRoot: flatRoot,
            outDir: flatRoot,
            watcher: createStubWatcher()
        });

        const req = createMockReq({ url: '/plain', method: 'GET' });
        const next = vi.fn();

        await middleware(req, {} as ServerResponse, next);

        expect(req.url).toBe('/plain.html');
        expect(next).toHaveBeenCalledOnce();

        await rm(flatRoot, { recursive: true, force: true });
    });
});
