// DB-free: db, import-service and pdf import are mocked, so this runs on a
// laptop without RUN_DB_TESTS.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, symlink, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  runImport: vi.fn(),
  importPdf: vi.fn(),
}));

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({
      from: async () => [{ id: 1, userId: 7, name: 'Compte' }],
    }),
  },
}));
vi.mock('../src/db/snapshotScheduler.js', () => ({ markDirty: vi.fn() }));
vi.mock('../src/domain/imports/import-service.js', () => ({ runImport: h.runImport }));
vi.mock('../src/domain/imports/pdf/index.js', () => ({ importPdf: h.importPdf }));

import { scanWatchFolderOnce } from '../src/domain/imports/watch-folder.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const OFX = 'OFXHEADER:100\r\n\r\n<OFX></OFX>';

let dir: string;
let sub: string;
let outside: string;

async function age(path: string, seconds: number): Promise<void> {
  const t = new Date(Date.now() - seconds * 1000);
  await utimes(path, t, t);
}

beforeEach(async () => {
  h.runImport.mockReset();
  h.runImport.mockResolvedValue({ insertedCount: 1, dedupSkipped: 0 });
  h.importPdf.mockReset();
  dir = await mkdtemp(join(tmpdir(), 'hoopoe-watch-scan-'));
  outside = await mkdtemp(join(tmpdir(), 'hoopoe-watch-outside-'));
  sub = join(dir, 'Compte');
  await mkdir(sub);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('scanWatchFolderOnce hardening', () => {
  it('does not follow a symlinked file out of the watch folder', async () => {
    const secret = join(outside, 'secret.csv');
    await writeFile(secret, 'top;secret;line\n');
    await symlink(secret, join(sub, 'innocent.csv'));

    const result = await scanWatchFolderOnce(dir, log);

    expect(h.runImport).not.toHaveBeenCalled();
    expect(result.imported + result.failed).toBe(0);
    expect(await readdir(sub)).toEqual(['innocent.csv']);
  });

  it('leaves a file that was modified moments ago (copy may still be in progress)', async () => {
    await writeFile(join(sub, 'fresh.ofx'), OFX);

    const result = await scanWatchFolderOnce(dir, log);

    expect(h.runImport).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
    expect(await readdir(sub)).toEqual(['fresh.ofx']);
  });

  it('imports the same file once it has been quiet for a while', async () => {
    const f = join(sub, 'settled.ofx');
    await writeFile(f, OFX);
    await age(f, 120);

    const result = await scanWatchFolderOnce(dir, log);

    expect(h.runImport).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(1);
    expect(await readdir(sub)).toEqual(['settled.ofx.imported']);
  });

  it('fails an oversize file without reading it into memory', async () => {
    const f = join(sub, 'huge.csv');
    await writeFile(f, Buffer.alloc(21 * 1024 * 1024, 0x61));
    await age(f, 120);

    const result = await scanWatchFolderOnce(dir, log);

    expect(h.runImport).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect((await readdir(sub)).sort()).toEqual(['huge.csv.error.txt', 'huge.csv.failed']);
  });
});
