import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dataDir } from '../../dataDir.js';
import { env } from '../../env.js';
import { DestinationNotAllowedError } from './errors.js';

// Folder destinations are confined to BACKUP_FOLDER_ROOT when it is set.
// Otherwise the server/Docker build allows only `<DATA_DIR>/backups`, and the
// desktop build (AUTH_MODE=none, forced by the Tauri entry; loopback only)
// allows the home directory plus where external disks and mounted shares
// appear, since backing up to one is the main reason to pick a folder.
export function desktopFolderRoots(platform: NodeJS.Platform): string[] {
  const home = homedir();
  if (platform === 'darwin') return [home, '/Volumes'];
  if (platform === 'win32') {
    const system = (process.env.SystemDrive ?? 'C:').slice(0, 1).toUpperCase();
    const drives: string[] = [];
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      if (letter !== system) drives.push(`${letter}:\\`);
    }
    return [home, ...drives];
  }
  return [home, '/media', '/run/media', '/mnt'];
}

export function backupFolderRoots(): string[] {
  if (env.BACKUP_FOLDER_ROOT) return [resolve(env.BACKUP_FOLDER_ROOT)];
  return env.AUTH_MODE === 'none'
    ? desktopFolderRoots(process.platform)
    : [join(dataDir(), 'backups')];
}

// realpath of `p`, or of its nearest existing ancestor with the missing
// segments re-appended (they cannot be symlinks, they do not exist).
async function realpathOfNearest(p: string): Promise<string> {
  const missing: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(await realpath(cur), ...missing);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(cur);
      if (parent === cur) return join(cur, ...missing);
      missing.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

export async function assertFolderInsideRoot(path: string): Promise<void> {
  const roots = backupFolderRoots();
  const [targetReal, ...rootsReal] = await Promise.all(
    [path, ...roots].map((p) => realpathOfNearest(p)),
  );
  if (!rootsReal.some((r) => isInside(r, targetReal!))) {
    throw new DestinationNotAllowedError(
      `folder must be inside BACKUP_FOLDER_ROOT (${roots.join(', ')}); move it there or set BACKUP_FOLDER_ROOT`,
    );
  }
}
