import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  deriveContentKey, encryptEnvelope, decryptEnvelope,
} from '../../src/domain/mcp/crypto.js';
const RUN = !!process.env.RUN_DB_TESTS;

const USER = 'rpcuser';
function aad(dir: 'req' | 'res') { return `hoopoe-mcp-v1|${USER}|${dir}`; }

describe.skipIf(!RUN)('POST /api/mcp/rpc', () => {
  let app: FastifyInstance;
  let cookie: string;
  let key: Buffer;

  async function call(op: string, args: Record<string, unknown>, ts = Date.now()) {
    const { nonce, ct } = encryptEnvelope(key, aad('req'), JSON.stringify({ op, args, ts }));
    const res = await app.inject({ method: 'POST', url: '/api/mcp/rpc', payload: { user: USER, v: 1, nonce, ct } });
    return res;
  }
  function decode(res: { json: () => any }) {
    const body = res.json();
    return JSON.parse(decryptEnvelope(key, aad('res'), body.nonce, body.ct));
  }

  beforeAll(async () => {
    const { buildApp } = await import('../helpers/build-app.js');
    app = await buildApp();
    await app.inject({ method: 'POST', url: '/api/onboarding/create', payload: { username: USER, password: 'rpc-12345' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: USER, password: 'rpc-12345' } });
    cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
    await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { enabled: true, readOnly: false } });
    const token = (await app.inject({ method: 'POST', url: '/api/settings/mcp/token', headers: { cookie } })).json().token;
    key = deriveContentKey(Buffer.from(token, 'base64url'));
  });
  afterEach(async () => {
    const { db } = await import('../../src/db/client.js');
    const { transactions, accounts } = await import('../../src/db/schema.js');
    await db.delete(transactions);
    await db.delete(accounts);
  });

  it('create → search → update → delete round trip (all encrypted)', async () => {
    const acc = await app.inject({
      method: 'POST', url: '/api/accounts', headers: { cookie },
      payload: { name: 'RPC', type: 'courant', openingDate: '2026-01-01' },
    });
    const accountId = acc.json().account.id;

    const created = decode(await call('create_transaction', { accountId, date: '2026-02-01', amount: '-12.34', rawLabel: 'Coffee' }));
    expect(created.status).toBe(201);
    const id = created.body.transaction.id;

    const found = decode(await call('search_transactions', { search: 'Coffee' }));
    expect(found.status).toBe(200);
    expect(found.body.transactions.some((t: any) => t.id === id)).toBe(true);

    const updated = decode(await call('update_transaction', { id, notes: 'from mcp' }));
    expect(updated.status).toBe(200);
    expect(updated.body.transaction.notes).toBe('from mcp');

    const removed = decode(await call('delete_transaction', { id }));
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
  });

  it('delete_transaction with a path-traversal id is confined (no splits route escape)', async () => {
    const acc = await app.inject({
      method: 'POST', url: '/api/accounts', headers: { cookie },
      payload: { name: 'RPC-confine', type: 'courant', openingDate: '2026-01-01' },
    });
    const accountId = acc.json().account.id;
    const created = decode(await call('create_transaction', { accountId, date: '2026-02-01', amount: '-5.00', rawLabel: 'Keep me' }));
    expect(created.status).toBe(201);

    const traversal = decode(await call('delete_transaction', { id: '5/splits' }));
    expect(traversal.status).not.toBe(200);
    expect([400, 404]).toContain(traversal.status);

    const found = decode(await call('search_transactions', { search: 'Keep me' }));
    expect(found.status).toBe(200);
    expect(found.body.transactions.some((t: any) => t.id === created.body.transaction.id)).toBe(true);
  });

  it('list_accounts and list_categories return 200 encrypted', async () => {
    expect(decode(await call('list_accounts', {})).status).toBe(200);
    expect(decode(await call('list_categories', {})).status).toBe(200);
  });

  it('unknown op → encrypted 400', async () => {
    expect(decode(await call('drop_tables', {})).status).toBe(400);
  });

  it('bad tag (wrong key) → plaintext 401', async () => {
    const wrong = deriveContentKey(Buffer.alloc(32, 9));
    const { nonce, ct } = encryptEnvelope(wrong, aad('req'), JSON.stringify({ op: 'list_accounts', args: {}, ts: Date.now() }));
    const res = await app.inject({ method: 'POST', url: '/api/mcp/rpc', payload: { user: USER, v: 1, nonce, ct } });
    expect(res.statusCode).toBe(401);
  });

  it('stale timestamp → plaintext 401', async () => {
    const res = await call('list_accounts', {}, Date.now() - 200_000);
    expect(res.statusCode).toBe(401);
  });

  it('unknown user → plaintext 401', async () => {
    const { nonce, ct } = encryptEnvelope(key, 'hoopoe-mcp-v1|ghost|req', JSON.stringify({ op: 'list_accounts', args: {}, ts: Date.now() }));
    const res = await app.inject({ method: 'POST', url: '/api/mcp/rpc', payload: { user: 'ghost', v: 1, nonce, ct } });
    expect(res.statusCode).toBe(401);
  });

  it('disabled MCP → plaintext 401', async () => {
    await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { enabled: false } });
    expect((await call('list_accounts', {})).statusCode).toBe(401);
    await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { enabled: true } });
  });

  it('a replayed envelope is refused', async () => {
    const { nonce, ct } = encryptEnvelope(key, aad('req'), JSON.stringify({ op: 'list_accounts', args: {}, ts: Date.now() }));
    const send = () => app.inject({ method: 'POST', url: '/api/mcp/rpc', payload: { user: USER, v: 1, nonce, ct } });
    expect((await send()).statusCode).toBe(200);
    const again = await send();
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: 'authentication failed' });
  });

  it('every authentication failure has the same body (no username oracle)', async () => {
    const ghost = encryptEnvelope(key, 'hoopoe-mcp-v1|ghost|req', JSON.stringify({ op: 'list_accounts', args: {}, ts: Date.now() }));
    const unknown = await app.inject({ method: 'POST', url: '/api/mcp/rpc', payload: { user: 'ghost', v: 1, ...ghost } });
    const wrong = deriveContentKey(Buffer.alloc(32, 9));
    const bad = encryptEnvelope(wrong, aad('req'), JSON.stringify({ op: 'list_accounts', args: {}, ts: Date.now() }));
    const badTag = await app.inject({ method: 'POST', url: '/api/mcp/rpc', payload: { user: USER, v: 1, ...bad } });
    const stale = await call('list_accounts', {}, Date.now() - 200_000);
    await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { enabled: false } });
    const disabled = await call('list_accounts', {});
    await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { enabled: true } });

    for (const res of [unknown, badTag, stale, disabled]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'authentication failed' });
    }
  });

  describe('read-only scope', () => {
    async function setReadOnly(readOnly: boolean) {
      await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { readOnly } });
    }
    afterEach(async () => { await setReadOnly(false); });

    it('read-only: reads work, writes get an encrypted 403 and change nothing', async () => {
      const acc = await app.inject({
        method: 'POST', url: '/api/accounts', headers: { cookie },
        payload: { name: 'RO', type: 'courant', openingDate: '2026-01-01' },
      });
      const accountId = acc.json().account.id;
      const created = decode(await call('create_transaction', { accountId, date: '2026-02-01', amount: '-9.99', rawLabel: 'Original' }));
      expect(created.status).toBe(201);
      const id = created.body.transaction.id;

      await setReadOnly(true);

      expect(decode(await call('search_transactions', { search: 'Original' })).status).toBe(200);
      expect(decode(await call('list_accounts', {})).status).toBe(200);

      const create = decode(await call('create_transaction', { accountId, date: '2026-02-02', amount: '-1.00', rawLabel: 'Blocked' }));
      expect(create.status).toBe(403);
      expect(create.body).toEqual({ error: 'read-only MCP token: create_transaction is not allowed' });
      const update = decode(await call('update_transaction', { id, notes: 'nope' }));
      expect(update.status).toBe(403);
      const del = decode(await call('delete_transaction', { id }));
      expect(del.status).toBe(403);
      expect(del.body).toEqual({ error: 'read-only MCP token: delete_transaction is not allowed' });

      const { db } = await import('../../src/db/client.js');
      const { transactions } = await import('../../src/db/schema.js');
      const rows = await db.select().from(transactions);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(id);
      expect(rows[0]!.notes ?? null).toBeNull();
    });

    it('unknown ops stay 400 when read-only', async () => {
      await setReadOnly(true);
      expect(decode(await call('drop_tables', {})).status).toBe(400);
    });

    it('read-write: create works again after allowing changes', async () => {
      const acc = await app.inject({
        method: 'POST', url: '/api/accounts', headers: { cookie },
        payload: { name: 'RW', type: 'courant', openingDate: '2026-01-01' },
      });
      const accountId = acc.json().account.id;
      await setReadOnly(true);
      expect(decode(await call('create_transaction', { accountId, date: '2026-02-01', amount: '-2.00', rawLabel: 'X' })).status).toBe(403);
      await setReadOnly(false);
      expect(decode(await call('create_transaction', { accountId, date: '2026-02-01', amount: '-2.00', rawLabel: 'X' })).status).toBe(201);
    });
  });
});
