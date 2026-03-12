import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

/**
 * Creates a collection of file-system utility helpers scoped to a given
 * project root. Paths that begin with an underscore-prefixed segment are
 * treated as private and are skipped during directory walks.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ walkFiles: Function, ensureDir: Function, copyFileWithParents: Function, loadJson: Function }}
 */
function createSiteUtils(projectRoot) {
    /**
     * Returns true if any segment of `absPath` (relative to `projectRoot`)
     * starts with an underscore, indicating the path should be ignored.
     *
     * @param {string} absPath - Absolute path to test.
     * @returns {boolean}
     */
    function shouldIgnorePath(absPath) {
        const rel = path.relative(projectRoot, absPath);
        const segments = rel.split(path.sep);
        return segments.some((segment) => segment.startsWith('_'));
    }

    /**
     * Recursively collects all file paths inside `dirPath`, skipping any
     * entry whose path contains an underscore-prefixed segment.
     *
     * @param {string} dirPath - Absolute path of the directory to walk.
     * @returns {Promise<string[]>} Flat list of absolute file paths.
     */
    async function walkFiles(dirPath) {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        const files = [];

        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (shouldIgnorePath(entryPath)) {
                continue;
            }

            if (entry.isDirectory()) {
                files.push(...(await walkFiles(entryPath)));
                continue;
            }

            files.push(entryPath);
        }

        return files;
    }

    /**
     * Creates `dirPath` and any missing parent directories (equivalent to `mkdir -p`).
     *
     * @param {string} dirPath - Absolute path of the directory to create.
     * @returns {Promise<void>}
     */
    async function ensureDir(dirPath) {
        await fsp.mkdir(dirPath, { recursive: true });
    }

    /**
     * Copies a file to `targetPath`, creating any missing parent directories first.
     *
     * @param {string} sourcePath - Absolute path of the source file.
     * @param {string} targetPath - Absolute path of the destination file.
     * @returns {Promise<void>}
     */
    async function copyFileWithParents(sourcePath, targetPath) {
        await ensureDir(path.dirname(targetPath));
        await fsp.copyFile(sourcePath, targetPath);
    }

    /**
     * Reads and parses a JSON file. Returns an empty object if the file does
     * not exist, so callers can safely spread the result without null-checking.
     *
     * @param {string} jsonPath - Absolute path to the JSON file.
     * @returns {Promise<object>}
     */
    async function loadJson(jsonPath) {
        if (!fs.existsSync(jsonPath)) {
            return {};
        }
        return JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    }

    return {
        walkFiles,
        ensureDir,
        copyFileWithParents,
        loadJson
    };
}

export { createSiteUtils };
