import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../src/env.js';
import { assertFolderInsideRoot, backupFolderRoots, desktopFolderRoots, isInside } from '../src/domain/backup/folder-root.js';
import { createFolderProvider } from '../src/domain/backup/providers.js';
import { DestinationNotAllowedError } from '../src/domain/backup/errors.js';

const NAME = 'hoopoe-backup-2026-08-05-030000.enc.json';
let base: string;
let root: string;
const saved = { root: env.BACKUP_FOLDER_ROOT, auth: env.AUTH_MODE };

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hoopoe-root-')));
  root = join(base, 'root');
  await mkdir(root);
  env.BACKUP_FOLDER_ROOT = root;
});
afterEach(async () => {
  env.BACKUP_FOLDER_ROOT = saved.root;
  env.AUTH_MODE = saved.auth;
  await rm(base, { recursive: true, force: true });
});

describe('backup folder root', () => {
  it('compares path segments, not string prefixes', () => {
    expect(isInside('/data/backups', '/data/backups')).toBe(true);
    expect(isInside('/data/backups', '/data/backups/a/b')).toBe(true);
    expect(isInside('/data/backups', '/data/backups-evil')).toBe(false);
    expect(isInside('/data/backups', '/data')).toBe(false);
  });

  it('allows the root, a subfolder, and a not-yet-existing subfolder', async () => {
    await mkdir(join(root, 'nas'));
    await expect(assertFolderInsideRoot(root)).resolves.toBeUndefined();
    await expect(assertFolderInsideRoot(join(root, 'nas'))).resolves.toBeUndefined();
    await expect(assertFolderInsideRoot(join(root, 'later', 'deeper'))).resolves.toBeUndefined();
  });

  it('refuses a sibling sharing the root name as a prefix', async () => {
    const sibling = join(base, 'root-evil');
    await mkdir(sibling);
    await expect(assertFolderInsideRoot(sibling)).rejects.toThrow(/BACKUP_FOLDER_ROOT/);
  });

  it('refuses paths outside the root and ".." escapes', async () => {
    await expect(assertFolderInsideRoot(base)).rejects.toBeInstanceOf(DestinationNotAllowedError);
    await expect(assertFolderInsideRoot(join(root, '..', 'elsewhere'))).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
  });

  it('follows symlinks: a link inside the root pointing outside is refused', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'link'));
    await expect(assertFolderInsideRoot(join(root, 'link'))).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
    await expect(assertFolderInsideRoot(join(root, 'link', 'new'))).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
  });

  it('the folder provider re-checks the root on every operation', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    const p = createFolderProvider(outside);
    await expect(p.upload(NAME, Buffer.from('x'))).rejects.toThrow(/BACKUP_FOLDER_ROOT/);
    await expect(p.list()).rejects.toBeInstanceOf(DestinationNotAllowedError);
    await expect(p.remove(NAME)).rejects.toBeInstanceOf(DestinationNotAllowedError);
  });

  it('defaults: <DATA_DIR>/backups on the server build, home + removable mounts on desktop', () => {
    env.BACKUP_FOLDER_ROOT = undefined;
    const prevData = process.env.DATA_DIR;
    process.env.DATA_DIR = '/srv/hoopoe-data';
    try {
      env.AUTH_MODE = 'session';
      expect(backupFolderRoots()).toEqual(['/srv/hoopoe-data/backups']);
      env.AUTH_MODE = 'none';
      expect(backupFolderRoots()).toEqual(desktopFolderRoots(process.platform));
      expect(backupFolderRoots()).toContain(homedir());
      // An explicit root replaces the defaults in both modes.
      env.BACKUP_FOLDER_ROOT = '/mnt/nas';
      expect(backupFolderRoots()).toEqual(['/mnt/nas']);
    } finally {
      if (prevData === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prevData;
    }
  });
});

describe('desktop folder roots', () => {
  it('macOS: home and /Volumes (external disks, mounted shares)', () => {
    expect(desktopFolderRoots('darwin')).toEqual([homedir(), '/Volumes']);
  });

  it('Linux: home and the usual removable / manual mount points', () => {
    expect(desktopFolderRoots('linux')).toEqual([homedir(), '/media', '/run/media', '/mnt']);
  });

  it('Windows: home and every drive root except the system drive', () => {
    const prev = process.env.SystemDrive;
    process.env.SystemDrive = 'C:';
    try {
      const roots = desktopFolderRoots('win32');
      expect(roots[0]).toBe(homedir());
      expect(roots).toContain('D:\\');
      expect(roots).toContain('Z:\\');
      expect(roots).not.toContain('C:\\');
      expect(roots).toHaveLength(1 + 25);
    } finally {
      if (prev === undefined) delete process.env.SystemDrive;
      else process.env.SystemDrive = prev;
    }
  });

  it('allows a folder under a desktop mount root when no BACKUP_FOLDER_ROOT is set', async () => {
    env.BACKUP_FOLDER_ROOT = undefined;
    env.AUTH_MODE = 'none';
    await expect(assertFolderInsideRoot(join(homedir(), 'Backups', 'hoopoe'))).resolves.toBeUndefined();
    await expect(assertFolderInsideRoot('/etc/hoopoe')).rejects.toBeInstanceOf(DestinationNotAllowedError);
  });
});
