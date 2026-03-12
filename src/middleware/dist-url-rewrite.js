import fs from 'fs';
import path from 'path';

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
 *
 * @param {object} options
 * @param {string} options.projectRoot - Absolute path to the project root.
 * @param {string} options.outDir      - Absolute path to the Vite output directory.
 * @param {import('chokidar').FSWatcher} options.watcher - Vite's file watcher instance.
 * @returns {import('connect').HandleFunction} Express/Connect middleware function.
 */
function createDistUrlRewrite(options) {
    const { projectRoot, outDir, watcher } = options;
    const STAT_CACHE_TTL_MS = 1000;
    const RESOLUTION_CACHE_TTL_MS = 1000;
    const MAX_CACHE_ENTRIES = 1024;
    const fileStatCache = new Map();
    const resolutionCache = new Map();
    const inFlightResolution = new Map();
    const distBasePath = getDistPublicBasePath();

    /**
     * Returns the URL base path under which the output directory is served,
     * expressed as an absolute-style path string (e.g. `'/dist'` or `'/'`).
     * Used to construct rewritten URLs and to skip requests that already point
     * into the output directory.
     *
     * @returns {string}
     */
    function getDistPublicBasePath() {
        const relativeOutDir = path.relative(projectRoot, outDir).split(path.sep).join('/');
        return relativeOutDir ? `/${relativeOutDir}` : '/';
    }

    /**
     * Evicts the oldest entry from `map` if it has reached `MAX_CACHE_ENTRIES`.
     * Keeps memory usage bounded without a full flush.
     *
     * @param {Map} map
     */
    function trimCache(map) {
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
     * Called by the watcher when a file inside `outDir` changes, ensuring
     * stale entries are not served after a re-render.
     */
    function clearCaches() {
        fileStatCache.clear();
        resolutionCache.clear();
        inFlightResolution.clear();
    }

    if (watcher && typeof watcher.on === 'function') {
        const invalidateOnSourceChange = (filePath) => {
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
     *
     * @param {string} absPath - Absolute path to check.
     * @returns {boolean}
     */
    function isWithinOutDir(absPath) {
        const normalizedOutDir = path.resolve(outDir);
        const normalizedTarget = path.resolve(absPath);
        return (
            normalizedTarget === normalizedOutDir ||
            normalizedTarget.startsWith(`${normalizedOutDir}${path.sep}`)
        );
    }

    /**
     * Produces an ordered list of candidate file paths (relative to `outDir`)
     * that could satisfy a given URL pathname. Resolution order:
     * - `/`            → `index.html`
     * - `/foo/`        → `foo/index.html`
     * - `/foo.ext`     → `foo.ext`  (has extension — only one candidate)
     * - `/foo`         → `foo`, `foo.html`, `foo/index.html`
     *
     * @param {string} pathname - URL pathname (e.g. `/fr/about`).
     * @returns {string[]} Ordered candidates, relative to `outDir`.
     */
    function buildDistCandidates(pathname) {
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
     *
     * @param {string} candidatePath - Absolute path to check.
     * @returns {Promise<boolean>}
     */
    async function isExistingFile(candidatePath) {
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
            if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
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
     * Concurrent calls for the same pathname share a single in-flight promise
     * to prevent duplicate filesystem lookups.
     *
     * @param {string} pathname - URL pathname to resolve (e.g. `/fr/about`).
     * @returns {Promise<string|null>} Relative path inside `outDir`, or `null` if not found.
     */
    async function resolveExistingDistPath(pathname) {
        const now = Date.now();
        const cached = resolutionCache.get(pathname);
        if (cached && cached.expiresAt > now) {
            return cached.value;
        }

        if (inFlightResolution.has(pathname)) {
            return inFlightResolution.get(pathname);
        }

        const resolutionPromise = (async () => {
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
     * Passes through unchanged for Vite-internal paths, unresolvable paths,
     * and non-GET/HEAD methods.
     *
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse}  res
     * @param {Function} next
     * @returns {Promise<void>}
     */
    return async function distUrlRewriteMiddleware(req, res, next) {
        if (!req.url || (req.method !== 'GET' && req.method !== 'HEAD')) {
            return next();
        }

        let parsed;
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
