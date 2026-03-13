import fs from 'fs';
import path from 'path';
import type { ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

export interface DistUrlRewriteOptions {
    projectRoot: string;
    outDir: string;
    watcher: ViteDevServer['watcher'];
}

type NextFunction = (err?: unknown) => void;
type ConnectMiddleware = (req: IncomingMessage, res: ServerResponse, next: NextFunction) => Promise<void>;

interface StatCacheEntry {
    isFile: boolean;
    expiresAt: number;
}

interface ResolutionCacheEntry {
    value: string | null;
    expiresAt: number;
}

/**
 * Creates a Connect-compatible middleware that rewrites incoming request URLs
 * to their pre-built counterparts in the Vite output directory (`outDir`).
 *
 * This allows the Vite dev server to serve the statically rendered HTML pages
 * (written to `outDir` by the Twig render step) as if they were first-class
 * dev-server routes. For example, a request for `/fr/about` is transparently
 * rewritten to `/<outDir>/fr/about.html`.
 *
 * URL resolution is cached with a short TTL and invalidated whenever the file
 * watcher reports a change inside `outDir`. Vite-internal paths (`/@vite`,
 * `/@fs`, etc.) are always bypassed without touching the cache.
 */
function createDistUrlRewrite(options: DistUrlRewriteOptions): ConnectMiddleware {
    const { projectRoot, outDir, watcher } = options;
    const STAT_CACHE_TTL_MS = 1000;
    const RESOLUTION_CACHE_TTL_MS = 1000;
    const MAX_CACHE_ENTRIES = 1024;
    const fileStatCache = new Map<string, StatCacheEntry>();
    const resolutionCache = new Map<string, ResolutionCacheEntry>();
    const inFlightResolution = new Map<string, Promise<string | null>>();
    const distBasePath = getDistPublicBasePath();

    /**
     * Returns the URL base path under which the output directory is served,
     * expressed as an absolute-style path string (e.g. `'/dist'` or `'/'`).
     */
    function getDistPublicBasePath(): string {
        const relativeOutDir = path.relative(projectRoot, outDir).split(path.sep).join('/');
        return relativeOutDir ? `/${relativeOutDir}` : '/';
    }

    /**
     * Evicts the oldest entry from `map` if it has reached `MAX_CACHE_ENTRIES`.
     * Keeps memory usage bounded without a full flush.
     */
    function trimCache<K, V>(map: Map<K, V>): void {
        if (map.size < MAX_CACHE_ENTRIES) {
            return;
        }
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) {
            map.delete(firstKey);
        }
    }

    /**
     * Clears all caches (file-stat, resolution, and in-flight).
     * Called by the watcher when a file inside `outDir` changes.
     */
    function clearCaches(): void {
        fileStatCache.clear();
        resolutionCache.clear();
        inFlightResolution.clear();
    }

    if (watcher && typeof watcher.on === 'function') {
        const invalidateOnSourceChange = (filePath: string): void => {
            const absolutePath = path.resolve(projectRoot, filePath);
            if (isWithinOutDir(absolutePath)) {
                clearCaches();
            }
        };
        watcher.on('add', invalidateOnSourceChange);
        watcher.on('change', invalidateOnSourceChange);
        watcher.on('unlink', invalidateOnSourceChange);
    }

    /**
     * Returns true if `absPath` is equal to, or nested inside, the resolved
     * output directory. Used to guard against path-traversal candidates.
     */
    function isWithinOutDir(absPath: string): boolean {
        const normalizedOutDir = path.resolve(outDir);
        const normalizedTarget = path.resolve(absPath);
        return (
            normalizedTarget === normalizedOutDir ||
            normalizedTarget.startsWith(`${normalizedOutDir}${path.sep}`)
        );
    }

    /**
     * Produces an ordered list of candidate file paths (relative to `outDir`)
     * that could satisfy a given URL pathname.
     */
    function buildDistCandidates(pathname: string): string[] {
        const cleaned = pathname.replace(/^\/+/, '');
        if (!cleaned) {
            return ['index.html'];
        }

        if (cleaned.endsWith('/')) {
            return [`${cleaned}index.html`];
        }

        if (path.extname(cleaned)) {
            return [cleaned];
        }

        return [cleaned, `${cleaned}.html`, `${cleaned}/index.html`];
    }

    /**
     * Checks whether `candidatePath` points to an existing file, with results
     * cached for `STAT_CACHE_TTL_MS` milliseconds to avoid repeated syscalls.
     */
    async function isExistingFile(candidatePath: string): Promise<boolean> {
        const now = Date.now();
        const cached = fileStatCache.get(candidatePath);
        if (cached && cached.expiresAt > now) {
            return cached.isFile;
        }

        let isFile = false;
        try {
            const stat = await fs.promises.stat(candidatePath);
            isFile = stat.isFile();
        } catch (error) {
            const nodeError = error as NodeJS.ErrnoException;
            if (nodeError?.code !== 'ENOENT' && nodeError?.code !== 'ENOTDIR') {
                throw error;
            }
        }

        trimCache(fileStatCache);
        fileStatCache.set(candidatePath, {
            isFile,
            expiresAt: now + STAT_CACHE_TTL_MS
        });
        return isFile;
    }

    /**
     * Resolves a URL pathname to an existing file path relative to `outDir`
     * by trying the candidates returned by `buildDistCandidates` in order.
     *
     * Results are cached for `RESOLUTION_CACHE_TTL_MS` milliseconds.
     * Concurrent calls for the same pathname share a single in-flight promise.
     */
    async function resolveExistingDistPath(pathname: string): Promise<string | null> {
        const now = Date.now();
        const cached = resolutionCache.get(pathname);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }

        const inflight = inFlightResolution.get(pathname);
        if (inflight) {
            return inflight;
        }

        const resolutionPromise = (async (): Promise<string | null> => {
            const candidates = buildDistCandidates(pathname);
            for (const candidate of candidates) {
                const candidatePath = path.resolve(outDir, candidate);
                if (!isWithinOutDir(candidatePath)) {
                    continue;
                }
                if (await isExistingFile(candidatePath)) {
                    trimCache(resolutionCache);
                    resolutionCache.set(pathname, {
                        value: candidate,
                        expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS
                    });
                    return candidate;
                }
            }

            trimCache(resolutionCache);
            resolutionCache.set(pathname, {
                value: null,
                expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS
            });
            return null;
        })();

        inFlightResolution.set(pathname, resolutionPromise);
        try {
            return await resolutionPromise;
        } finally {
            inFlightResolution.delete(pathname);
        }
    }

    /**
     * Connect middleware. Rewrites `req.url` for GET/HEAD requests whose
     * pathname maps to an existing file in `outDir`, then calls `next()`.
     */
    return async function distUrlRewriteMiddleware(req, _res, next) {
        if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
            return next();
        }

        let parsed: URL;
        try {
            parsed = new URL(req.url, 'http://localhost');
        } catch (_error) {
            return next();
        }

        const pathname = parsed.pathname;
        const shouldBypass =
            pathname.startsWith('/@vite') ||
            pathname.startsWith('/@fs/') ||
            pathname.startsWith('/@id/') ||
            pathname.startsWith('/__vite') ||
            pathname.startsWith('/node_modules/') ||
            pathname.startsWith('/src/') ||
            pathname.startsWith(`${distBasePath}/`);

        if (shouldBypass) {
            return next();
        }

        try {
            const matchedDistPath = await resolveExistingDistPath(pathname);
            if (!matchedDistPath) {
                return next();
            }

            req.url =
                distBasePath === '/'
                    ? `/${matchedDistPath}${parsed.search}`
                    : `${distBasePath}/${matchedDistPath}${parsed.search}`;
        } catch (error) {
            console.error('[dist-url-rewrite] path resolution failed:', error);
        }

        return next();
    };
}

export { createDistUrlRewrite };
