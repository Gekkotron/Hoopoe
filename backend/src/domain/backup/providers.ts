import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isBackupFilename } from './dump.js';
import { BackupProviderError, categorizeNetworkError } from './errors.js';
import { assertFolderInsideRoot } from './folder-root.js';
import { hasControlChars, resolveAllowedAddresses } from './net-guard.js';

export { BackupProviderError } from './errors.js';

// Destination abstraction for scheduled remote backups. Two providers:
// a local/mounted folder (SMB/NFS mount, external disk) and WebDAV
// (Freebox, Synology, QNAP, Nextcloud) over plain fetch — no npm dep.
// list() pre-filters to backup-named files so retention pruning can NEVER
// delete a foreign file living in the same directory.

// The filter parameter lets callers pick which family of names the provider
// returns — the JSON dump (`isBackupFilename` from dump.ts) or the
// attachment archive (`isAttachmentArchiveFilename` from the archive route).
// Default keeps the historical behaviour of returning only JSON dumps.
export type BackupNameFilter = (name: string) => boolean;

export interface BackupProvider {
  upload(name: string, bytes: Buffer): Promise<void>;
  list(filter?: BackupNameFilter): Promise<string[]>;
  remove(name: string): Promise<void>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Names come from our own stamp or the PUT-validation probe; anything with
// a path separator is refused outright. Shared with the FTP provider
// (ftp.ts).
export function assertPlainName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new BackupProviderError(`invalid backup filename: ${name}`);
  }
}

export function createFolderProvider(rawPath: string): BackupProvider {
  // A relative path would resolve against the server's cwd — always a bug.
  if (!isAbsolute(rawPath)) throw new BackupProviderError('folder path must be absolute');
  // Normalized once so the root check and the fs calls see the same path.
  const dirPath = resolve(rawPath);
  return {
    async upload(name, bytes) {
      assertPlainName(name);
      await assertFolderInsideRoot(dirPath);
      // Temp file + rename: a crash mid-write never leaves a truncated
      // backup under a name the pruner (or the user) would trust. The
      // directory must already exist — creating it here would silently
      // write to a local stub when an SMB/NFS mount is down.
      const tmp = join(dirPath, `.tmp-${name}`);
      try {
        await writeFile(tmp, bytes);
        await rename(tmp, join(dirPath, name));
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => {});
        throw new BackupProviderError(`folder write failed: ${errMsg(err)}`, 'folder unavailable');
      }
    },
    async list(filter = isBackupFilename) {
      await assertFolderInsideRoot(dirPath);
      try {
        return (await readdir(dirPath)).filter(filter).sort();
      } catch (err) {
        throw new BackupProviderError(`folder list failed: ${errMsg(err)}`, 'folder unavailable');
      }
    },
    async remove(name) {
      assertPlainName(name);
      await assertFolderInsideRoot(dirPath);
      try {
        await rm(join(dirPath, name), { force: true });
      } catch (err) {
        throw new BackupProviderError(`folder delete failed: ${errMsg(err)}`, 'folder unavailable');
      }
    },
  };
}

// Injectable fetch, same policy as the Enable Banking client: tests never
// touch the network.
let testFetch: typeof fetch | null = null;
export function __setBackupFetchForTests(f: typeof fetch | null): void {
  testFetch = f;
}

// Per-request ceilings. Probe/list/delete/mkcol are small; an upload carries
// the whole sealed backup (plus attachments archive) so it gets longer.
export const WEBDAV_TIMEOUT_MS = 30_000;
export const WEBDAV_UPLOAD_TIMEOUT_MS = 300_000;

export function createWebdavProvider(
  cfg: { url: string; username: string; subdir: string | null },
  password: string,
): BackupProvider {
  if (hasControlChars(cfg.username) || hasControlChars(cfg.subdir ?? '')) {
    throw new BackupProviderError('webdav username/subdir contain forbidden characters');
  }
  const auth = 'Basic ' + Buffer.from(`${cfg.username}:${password}`).toString('base64');
  const base = cfg.url.replace(/\/+$/, '');
  const segments = (cfg.subdir ?? '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(encodeURIComponent);
  const dirUrl = [base, ...segments].join('/');
  const fileUrl = (name: string) => `${dirUrl}/${encodeURIComponent(name)}`;

  async function request(
    method: string,
    url: string,
    extra: RequestInit = {},
    timeoutMs = WEBDAV_TIMEOUT_MS,
  ): Promise<Response> {
    // Re-vetted right before every request: fetch resolves the name itself,
    // so this narrows (cannot fully close) the DNS-rebinding window. Redirects
    // are refused so a server cannot bounce us to a blocked address.
    await resolveAllowedAddresses(new URL(url).hostname);
    try {
      return await (testFetch ?? fetch)(url, {
        ...extra,
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: auth, ...(extra.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      throw new BackupProviderError(
        `webdav ${method} failed: ${errMsg(err)}`,
        categorizeNetworkError(err),
      );
    }
  }

  function httpError(action: string, status: number): BackupProviderError {
    if (status === 401 || status === 403) {
      return new BackupProviderError(
        `webdav ${action}: authentication failed (HTTP ${status})`,
        'authentication failed',
      );
    }
    return new BackupProviderError(`webdav ${action}: HTTP ${status}`);
  }

  async function put(name: string, bytes: Buffer): Promise<Response> {
    return request('PUT', fileUrl(name), { body: new Uint8Array(bytes) }, WEBDAV_UPLOAD_TIMEOUT_MS);
  }

  return {
    async upload(name, bytes) {
      assertPlainName(name);
      let res = await put(name, bytes);
      if (res.status === 409 && segments.length > 0) {
        // Missing collection — create each subdir level then retry once.
        // 405 = already exists, fine.
        let url = base;
        for (const seg of segments) {
          url = `${url}/${seg}`;
          const mk = await request('MKCOL', url);
          if (!mk.ok && mk.status !== 405) throw httpError('mkcol', mk.status);
        }
        res = await put(name, bytes);
      }
      if (!res.ok) throw httpError('upload', res.status);
    },
    async list(filter = isBackupFilename) {
      const res = await request('PROPFIND', dirUrl, { headers: { depth: '1' } });
      if (res.status === 404) return []; // nothing pushed yet
      if (!res.ok && res.status !== 207) throw httpError('list', res.status);
      let xml: string;
      try {
        xml = await res.text();
      } catch (err) {
        throw new BackupProviderError(
          `webdav list failed reading body: ${errMsg(err)}`,
          categorizeNetworkError(err),
        );
      }
      // Only <href> extraction is needed — no XML parser. Namespace prefix
      // varies by server (d:, D:, none), so match on the local name.
      const names: string[] = [];
      for (const m of xml.matchAll(/<[^<>]*href[^<>]*>([^<]+)<\/[^<>]*href[^<>]*>/gi)) {
        const decoded = decodeURIComponent((m[1] ?? '').trim());
        const basename = decoded.split('/').filter(Boolean).pop() ?? '';
        if (filter(basename)) names.push(basename);
      }
      return names.sort();
    },
    async remove(name) {
      assertPlainName(name);
      const res = await request('DELETE', fileUrl(name));
      if (!res.ok && res.status !== 404) throw httpError('delete', res.status);
    },
  };
}
