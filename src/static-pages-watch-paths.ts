import path from 'path';
import type { SiteUtils } from './site-utils.js';

export interface CollectStaticPagesWatchPathsOptions {
    projectRoot: string;
    staticDir: string;
    templatesDir: string;
    translationsDir: string;
    slugMapPath: string | null;
    walkFiles: SiteUtils['walkFiles'];
}

/**
 * Resolves the ordered list of filesystem paths passed to Vite `addWatchFile` for the
 * static-pages plugin (walks + `.twig` filter on the static tree + deduplication by
 * `path.resolve`). When `staticDir` is under `templatesDir`, page `.twig` files appear in
 * both walks; deduping avoids registering the same path twice (which can double `hotUpdate`
 * and full reloads). Shared with the plugin implementation so behaviour stays single-sourced.
 */
export async function collectStaticPagesWatchPaths(options: CollectStaticPagesWatchPathsOptions): Promise<string[]> {
    const { projectRoot, staticDir, templatesDir, translationsDir, slugMapPath, walkFiles } = options;
    const staticRoot = path.join(projectRoot, staticDir);
    const templatesRoot = path.join(projectRoot, templatesDir);
    const translationsRoot = path.join(projectRoot, translationsDir);

    const [staticFiles, templateFiles, translationFiles] = await Promise.all([
        walkFiles(staticRoot),
        walkFiles(templatesRoot),
        walkFiles(translationsRoot)
    ]);

    const twigFiles = staticFiles.filter((filePath) => path.extname(filePath).toLowerCase() === '.twig');
    const extraFiles = slugMapPath ? [path.resolve(projectRoot, slugMapPath)] : [];

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const filePath of [...twigFiles, ...templateFiles, ...translationFiles, ...extraFiles]) {
        const key = path.resolve(filePath);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        unique.push(filePath);
    }
    return unique;
}
