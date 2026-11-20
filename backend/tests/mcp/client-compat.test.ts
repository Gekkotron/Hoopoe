// Cross-package contract between the mcp/ client and the backend MCP route.
// Each side's own tests used their own AAD prefix, so a drift between them
// (athena-mcp-v1 vs hoopoe-mcp-v1) shipped with every call failing 401.
// These tests import the real client from mcp/src so a drift fails here.
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as backendCrypto from '../../src/domain/mcp/crypto.js';
import * as clientCrypto from '../../../mcp/src/crypto.js';
import { RpcClient } from '../../../mcp/src/client.js';

const RUN = !!process.env.RUN_DB_TESTS;

describe('mcp client ↔ backend wire format', () => {
  it('builds the same AAD on both sides', () => {
    for (const dir of ['req', 'res'] as const) {
      expect(clientCrypto.envelopeAad('alice', dir)).toBe(backendCrypto.envelopeAad('alice', dir));
    }
  });

  it('derives the same content key from a token', () => {
    const token = Buffer.alloc(32, 9);
    expect(clientCrypto.deriveContentKey(token).equals(backendCrypto.deriveContentKey(token))).toBe(true);
  });

  it('a client request opens on the backend and a backend response opens on the client', () => {
    const key = backendCrypto.deriveContentKey(Buffer.alloc(32, 3));
    const req = clientCrypto.encryptEnvelope(key, clientCrypto.envelopeAad('bob', 'req'), 'ping');
    expect(backendCrypto.decryptEnvelope(key, backendCrypto.envelopeAad('bob', 'req'), req.nonce, req.ct)).toBe('ping');
    const res = backendCrypto.encryptEnvelope(key, backendCrypto.envelopeAad('bob', 'res'), 'pong');
    expect(clientCrypto.decryptEnvelope(key, clientCrypto.envelopeAad('bob', 'res'), res.nonce, res.ct)).toBe('pong');
  });
});

describe.skipIf(!RUN)('mcp client against the real /api/mcp/rpc route', () => {
  const USER = 'mcp-compat-user';
  let app: FastifyInstance;
  let cookie: string;
  let client: RpcClient;

  beforeAll(async () => {
    const { buildApp } = await import('../helpers/build-app.js');
    app = await buildApp();
    await app.inject({ method: 'POST', url: '/api/onboarding/create', payload: { username: USER, password: 'mcp-compat-1234' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: USER, password: 'mcp-compat-1234' } });
    cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
    await app.inject({ method: 'PUT', url: '/api/settings/mcp', headers: { cookie }, payload: { enabled: true, readOnly: false } });
    const token = (await app.inject({ method: 'POST', url: '/api/settings/mcp/token', headers: { cookie } })).json().token as string;

    // Route the client's fetch through Fastify's injector: same handler,
    // same crypto, no socket.
    const injectFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      const res = await app.inject({
        method: init.method as 'POST',
        url: new URL(url).pathname,
        headers: init.headers,
        payload: init.body,
      });
      return {
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: async () => res.json(),
      };
    }) as unknown as typeof fetch;
    client = new RpcClient({ apiUrl: 'http://hoopoe.test', user: USER, token }, injectFetch);
  });

  it('lists accounts through the encrypted channel', async () => {
    await app.inject({
      method: 'POST', url: '/api/accounts', headers: { cookie },
      payload: { name: 'MCP compat', type: 'courant', openingDate: '2026-01-01' },
    });
    const body = await client.rpc('list_accounts', {}) as { accounts: Array<{ name: string }> };
    expect(body.accounts.map((a) => a.name)).toContain('MCP compat');
  });

  it('surfaces backend errors from the encrypted response', async () => {
    await expect(client.rpc('no_such_op', {})).rejects.toThrow(/no_such_op|unknown|rejected/i);
  });
});
