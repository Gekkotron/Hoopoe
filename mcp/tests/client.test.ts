import { describe, it, expect } from 'vitest';
import { RpcClient } from '../src/client.js';
import { deriveContentKey, encryptEnvelope, decryptEnvelope } from '../src/crypto.js';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const cfg = { apiUrl: 'http://backend.test', user: 'u', token: TOKEN };
const key = deriveContentKey(Buffer.from(TOKEN, 'base64url'));

// A fake fetch that decrypts the request, runs `handler`, and returns an
// encrypted { status, body } response envelope.
function fakeFetch(handler: (op: string, args: any) => { status: number; body: unknown }) {
  return async (_url: string, init: any) => {
    const { user, nonce, ct } = JSON.parse(init.body);
    const inner = JSON.parse(decryptEnvelope(key, `hoopoe-mcp-v1|${user}|req`, nonce, ct));
    const out = handler(inner.op, inner.args);
    const env = encryptEnvelope(key, `hoopoe-mcp-v1|${user}|res`, JSON.stringify(out));
    return { ok: true, status: 200, json: async () => ({ v: 1, nonce: env.nonce, ct: env.ct }) };
  };
}

describe('RpcClient', () => {
  it('returns the inner body on 2xx', async () => {
    const c = new RpcClient(cfg, fakeFetch(() => ({ status: 200, body: { accounts: [] } })) as any);
    expect(await c.rpc('list_accounts', {})).toEqual({ accounts: [] });
  });

  it('sends encrypted requests (no plaintext op on the wire)', async () => {
    let seenBody = '';
    const spy = async (_u: string, init: any) => {
      seenBody = init.body;
      const { user, nonce, ct } = JSON.parse(init.body);
      const env = encryptEnvelope(key, `hoopoe-mcp-v1|${user}|res`, JSON.stringify({ status: 200, body: {} }));
      return { ok: true, status: 200, json: async () => ({ v: 1, nonce: env.nonce, ct: env.ct }) };
    };
    const c = new RpcClient(cfg, spy as any);
    await c.rpc('create_transaction', { rawLabel: 'SecretMerchant' });
    expect(seenBody).not.toContain('SecretMerchant');
    expect(seenBody).not.toContain('create_transaction');
  });

  it('throws a mapped message on inner 409', async () => {
    const c = new RpcClient(cfg, fakeFetch(() => ({ status: 409, body: { error: 'doublon' } })) as any);
    await expect(c.rpc('create_transaction', {})).rejects.toThrow('doublon');
  });

  it('throws on inner 401', async () => {
    const c = new RpcClient(cfg, fakeFetch(() => ({ status: 401, body: {} })) as any);
    await expect(c.rpc('list_accounts', {})).rejects.toThrow(/disabled|invalid/i);
  });

  it('surfaces the read-only 403 message instead of "token invalid"', async () => {
    const msg = 'read-only MCP token: create_transaction is not allowed';
    const c = new RpcClient(cfg, fakeFetch(() => ({ status: 403, body: { error: msg } })) as any);
    await expect(c.rpc('create_transaction', {})).rejects.toThrow(msg);
  });

  it('still maps other 403s to the generic access message', async () => {
    const c = new RpcClient(cfg, fakeFetch(() => ({ status: 403, body: { error: 'forbidden' } })) as any);
    await expect(c.rpc('list_accounts', {})).rejects.toThrow(/disabled|invalid/i);
  });
});
