import { access, constants, mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSiteUtils } from './site-utils.js';

describe('createSiteUtils', () => {
    let tmpRoot: string;
    let projectRoot: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(path.join(tmpdir(), 'site-utils-'));
        projectRoot = path.join(tmpRoot, 'project');
        await mkdir(projectRoot, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    describe('walkFiles', () => {
        it('returns all file paths under the directory tree', async () => {
            await writeFile(path.join(projectRoot, 'a.txt'), 'a');
            await mkdir(path.join(projectRoot, 'nested'), { recursive: true });
            await writeFile(path.join(projectRoot, 'nested', 'b.txt'), 'b');

            const { walkFiles } = createSiteUtils(projectRoot);
            const files = await walkFiles(projectRoot);

            expect(files.sort()).toEqual(
                [path.join(projectRoot, 'a.txt'), path.join(projectRoot, 'nested', 'b.txt')].sort()
            );
        });

        it('skips paths under underscore-prefixed path segments', async () => {
            await writeFile(path.join(projectRoot, 'visible.txt'), '');
            await mkdir(path.join(projectRoot, '_private'), { recursive: true });
            await writeFile(path.join(projectRoot, '_private', 'secret.txt'), '');
            await mkdir(path.join(projectRoot, 'public'), { recursive: true });
            await writeFile(path.join(projectRoot, 'public', 'ok.txt'), '');
            await mkdir(path.join(projectRoot, 'public', '_partial'), { recursive: true });
            await writeFile(path.join(projectRoot, 'public', '_partial', 'skip.twig'), '');

            const { walkFiles } = createSiteUtils(projectRoot);
            const files = await walkFiles(projectRoot);

            expect(files.sort()).toEqual(
                [path.join(projectRoot, 'visible.txt'), path.join(projectRoot, 'public', 'ok.txt')].sort()
            );
        });

        it('skips files whose name starts with an underscore segment', async () => {
            await writeFile(path.join(projectRoot, 'keep.txt'), '');
            await writeFile(path.join(projectRoot, '_draft.txt'), '');

            const { walkFiles } = createSiteUtils(projectRoot);
            const files = await walkFiles(projectRoot);

            expect(files).toEqual([path.join(projectRoot, 'keep.txt')]);
        });
    });

    describe('loadJson', () => {
        it('returns an empty object when the file does not exist', async () => {
            const { loadJson } = createSiteUtils(projectRoot);
            const data = await loadJson(path.join(projectRoot, 'missing.json'));
            expect(data).toEqual({});
        });

        it('parses valid JSON when the file exists', async () => {
            const jsonPath = path.join(projectRoot, 'data.json');
            await writeFile(jsonPath, JSON.stringify({ hello: 'world', n: 42 }));

            const { loadJson } = createSiteUtils(projectRoot);
            const data = await loadJson(jsonPath);

            expect(data).toEqual({ hello: 'world', n: 42 });
        });
    });

    describe('ensureDir', () => {
        it('creates nested directories', async () => {
            const deep = path.join(projectRoot, 'a', 'b', 'c');
            const { ensureDir } = createSiteUtils(projectRoot);
            await ensureDir(deep);

            await expect(access(deep, constants.R_OK)).resolves.toBeUndefined();
        });
    });

    describe('copyFileWithParents', () => {
        it('copies a file and creates parent directories on the target path', async () => {
            const src = path.join(projectRoot, 'src.txt');
            await writeFile(src, 'content');
            const dest = path.join(projectRoot, 'out', 'nested', 'dest.txt');

            const { copyFileWithParents } = createSiteUtils(projectRoot);
            await copyFileWithParents(src, dest);

            await expect(readFile(dest, 'utf8')).resolves.toBe('content');
        });
    });
});
