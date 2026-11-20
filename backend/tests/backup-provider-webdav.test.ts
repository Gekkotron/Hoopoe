import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { __setLookupForTests, __setNetGuardBypassForTests } from '../src/domain/backup/net-guard.js';
import { DestinationNotAllowedError } from '../src/domain/backup/errors.js';
import {
  createWebdavProvider,
  WEBDAV_TIMEOUT_MS,
  WEBDAV_UPLOAD_TIMEOUT_MS,
  __setBackupFetchForTests,
  BackupProviderError,
} from '../src/domain/backup/providers.js';

type Call = { method: string; url: string; headers: Record<string, string> };
const NAME = 'hoopoe-backup-2026-08-05-030000.enc.json';

function fakeFetch(script: (call: Call, n: number) => Response): Call[] {
  const calls: Call[] = [];
  __setBackupFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    return script(call, calls.length);
  }) as typeof fetch);
  return calls;
}

afterEach(() => __setBackupFetchForTests(null));

const CFG = { url: 'http://nas.local:5005/dav/', username: 'julien', subdir: 'athena' };

describe('webdav provider', () => {
  it('uploads with basic auth to url/subdir/name', async () => {
    const calls = fakeFetch(() => new Response(null, { status: 201 }));
    await createWebdavProvider(CFG, 'p4ss').upload(NAME, Buffer.from('x'));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(`http://nas.local:5005/dav/athena/${NAME}`);
    expect(calls[0].headers.authorization).toBe('Basic ' + Buffer.from('julien:p4ss').toString('base64'));
  });
  it('a 409 PUT creates the collection with MKCOL then retries once', async () => {
    const calls = fakeFetch((_call, n) =>
      n === 1 ? new Response(null, { status: 409 }) : new Response(null, { status: 201 }),
    );
    await createWebdavProvider(CFG, 'p4ss').upload(NAME, Buffer.from('x'));
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'MKCOL', 'PUT']);
    expect(calls[1].url).toBe('http://nas.local:5005/dav/athena');
  });
  it('maps 401 to a readable error', async () => {
    fakeFetch(() => new Response(null, { status: 401 }));
    await expect(createWebdavProvider(CFG, 'wrong').upload(NAME, Buffer.from('x'))).rejects.toThrow(
      /authentication failed/i,
    );
  });
  it('lists via PROPFIND depth 1, decodes hrefs, filters foreign files', async () => {
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/dav/athena/</d:href></d:response>
      <d:response><d:href>/dav/athena/${NAME}</d:href></d:response>
      <d:response><d:href>/dav/athena/hoopoe-backup-2026-08-04-030000.enc.json</d:href></d:response>
      <d:response><d:href>/dav/athena/notes%20perso.txt</d:href></d:response>
    </d:multistatus>`;
    const calls = fakeFetch(() => new Response(xml, { status: 207 }));
    const names = await createWebdavProvider(CFG, 'p4ss').list();
    expect(calls[0].method).toBe('PROPFIND');
    expect(calls[0].headers.depth).toBe('1');
    expect(names).toEqual(['hoopoe-backup-2026-08-04-030000.enc.json', NAME]);
  });
  it('an unlisted (404) directory lists as empty', async () => {
    fakeFetch(() => new Response(null, { status: 404 }));
    expect(await createWebdavProvider(CFG, 'p4ss').list()).toEqual([]);
  });
  it('remove issues DELETE and tolerates 404', async () => {
    const calls = fakeFetch(() => new Response(null, { status: 404 }));
    await createWebdavProvider(CFG, 'p4ss').remove(NAME);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`http://nas.local:5005/dav/athena/${NAME}`);
  });
  it('network failure surfaces as BackupProviderError with the cause', async () => {
    __setBackupFetchForTests((async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as typeof fetch);
    await expect(createWebdavProvider(CFG, 'p4ss').list()).rejects.toThrow(BackupProviderError);
  });
});

describe('webdav provider hardening', () => {
  beforeEach(() => __setNetGuardBypassForTests(false));
  afterEach(() => {
    __setLookupForTests(null);
    __setNetGuardBypassForTests(true);
  });

  const lookupTo = (address: string) =>
    (async () => [{ address, family: 4 }]) as unknown as Parameters<typeof __setLookupForTests>[0];

  it.each(['http://127.0.0.1:5005/dav', 'http://169.254.169.254/latest', 'http://[::1]/dav'])(
    'refuses %s before any request is sent',
    async (url) => {
      const calls = fakeFetch(() => new Response(null, { status: 201 }));
      const p = createWebdavProvider({ url, username: 'u', subdir: null }, 'p');
      await expect(p.upload(NAME, Buffer.from('x'))).rejects.toBeInstanceOf(DestinationNotAllowedError);
      await expect(p.list()).rejects.toBeInstanceOf(DestinationNotAllowedError);
      await expect(p.remove(NAME)).rejects.toBeInstanceOf(DestinationNotAllowedError);
      expect(calls).toHaveLength(0);
    },
  );

  it('re-resolves the name before every request (a rebind to loopback is caught)', async () => {
    const calls = fakeFetch(() => new Response(null, { status: 201 }));
    __setLookupForTests(lookupTo('192.168.1.20'));
    const p = createWebdavProvider({ url: 'http://nas.example/dav', username: 'u', subdir: null }, 'p');
    await p.upload(NAME, Buffer.from('x'));
    expect(calls).toHaveLength(1);
    __setLookupForTests(lookupTo('127.0.0.1'));
    await expect(p.remove(NAME)).rejects.toBeInstanceOf(DestinationNotAllowedError);
    expect(calls).toHaveLength(1);
  });

  it('sends a timeout signal on every request and refuses redirects', async () => {
    const inits: RequestInit[] = [];
    __setBackupFetchForTests((async (_u: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init!);
      return new Response(null, { status: init?.method === 'PROPFIND' ? 207 : 201 });
    }) as typeof fetch);
    __setLookupForTests(lookupTo('192.168.1.20'));
    const p = createWebdavProvider({ url: 'http://nas.example/dav', username: 'u', subdir: null }, 'p');
    await p.upload(NAME, Buffer.from('x'));
    await p.list();
    expect(inits.map((i) => i.method)).toEqual(['PUT', 'PROPFIND']);
    for (const i of inits) {
      expect(i.signal).toBeInstanceOf(AbortSignal);
      expect(i.redirect).toBe('error');
    }
    expect(WEBDAV_UPLOAD_TIMEOUT_MS).toBeGreaterThan(WEBDAV_TIMEOUT_MS);
  });

  it('classifies a timeout and a refused connection', async () => {
    __setLookupForTests(lookupTo('192.168.1.20'));
    const p = createWebdavProvider({ url: 'http://nas.example/dav', username: 'u', subdir: null }, 'p');
    __setBackupFetchForTests((async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as typeof fetch);
    expect(await p.list().catch((e) => e.category)).toBe('timed out');
    __setBackupFetchForTests((async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch);
    expect(await p.list().catch((e) => e.category)).toBe('connection refused');
  });

  it('rejects CR/LF/NUL in username and subdir', () => {
    for (const bad of [
      { username: 'u\r\nX: y', subdir: null },
      { username: 'u', subdir: 'a\nb' },
    ]) {
      expect(() => createWebdavProvider({ url: 'http://nas.example/dav', ...bad }, 'p')).toThrow(
        BackupProviderError,
      );
    }
  });
});
