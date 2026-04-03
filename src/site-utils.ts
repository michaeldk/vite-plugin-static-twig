import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

export interface SiteUtils {
    walkFiles: (dirPath: string) => Promise<string[]>;
    ensureDir: (dirPath: string) => Promise<void>;
    copyFileWithParents: (sourcePath: string, targetPath: string) => Promise<void>;
    loadJson: (jsonPath: string) => Promise<Record<string, unknown>>;
}

/**
 * Creates a collection of file-system utility helpers scoped to a given
 * project root.
 */
function createSiteUtils(projectRoot: string): SiteUtils {
    /**
     * Recursively collects all file paths inside `dirPath`.
     */
    async function walkFiles(dirPath: string): Promise<string[]> {
        const entries = await fsp.readdir(dirPath, { withFileTypes: true });
        const files: string[] = [];

        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);

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
     */
    async function ensureDir(dirPath: string): Promise<void> {
        await fsp.mkdir(dirPath, { recursive: true });
    }

    /**
     * Copies a file to `targetPath`, creating any missing parent directories first.
     */
    async function copyFileWithParents(sourcePath: string, targetPath: string): Promise<void> {
        await ensureDir(path.dirname(targetPath));
        await fsp.copyFile(sourcePath, targetPath);
    }

    /**
     * Reads and parses a JSON file. Returns an empty object if the file does
     * not exist, so callers can safely spread the result without null-checking.
     */
    async function loadJson(jsonPath: string): Promise<Record<string, unknown>> {
        if (!fs.existsSync(jsonPath)) {
            return {};
        }
        return JSON.parse(await fsp.readFile(jsonPath, 'utf8')) as Record<string, unknown>;
    }

    return {
        walkFiles,
        ensureDir,
        copyFileWithParents,
        loadJson
    };
}

export { createSiteUtils };
