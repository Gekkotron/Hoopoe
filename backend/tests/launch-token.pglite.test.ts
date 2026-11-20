// Per-launch token guard (desktop sidecar). Boot pattern mirrors
// none-mode-host-guard.pglite.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshEnvForTests } from '../src/env.js';

const TOKEN = 'f'.repeat(64);
const KEYS = ['DB_DRIVER', 'AUTH_MODE', 'SESSION_SECRET', 'DATA_DIR', 'PGLITE_PATH', 'HOOPOE_LAUNCH_TOKEN'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
for (const k of KEYS) if (process.env[k] !== undefined) saved[k] = process.env[k];

let tmp: string;

async function boot(token: string | undefined): Promise<FastifyInstance> {
  process.env.AUTH_MODE = 'none';
  if (token === undefined) delete process.env.HOOPOE_LAUNCH_TOKEN;
  else process.env.HOOPOE_LAUNCH_TOKEN = token;
  refreshEnvForTests();
  const { runMigrations } = await import('../src/db/migrate.js');
  const { ensureLocalUser } = await import('../src/domain/auth/localUser.js');
  const { build } = await import('../src/buildServer.js');
  await runMigrations();
  await ensureLocalUser();
  return build({ logger: false });
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'hoopoe-launch-'));
  process.env.DB_DRIVER = 'pglite';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  process.env.DATA_DIR = tmp;
  process.env.PGLITE_PATH = path.join(tmp, 'athena.db');
});

afterAll(async () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  refreshEnvForTests();
  await rm(tmp, { recursive: true, force: true });
});

describe('launch token guard', () => {
  it('with the token set: cookie-less requests get 403, the launch exchange sets the cookie', async () => {
    const app = await boot(TOKEN);
    try {
      for (const url of ['/', '/api/accounts', '/health']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(403);
      }

      const wrong = await app.inject({ method: 'GET', url: '/__launch?token=wrong' });
      expect(wrong.statusCode).toBe(403);

      const ok = await app.inject({ method: 'GET', url: `/__launch?token=${TOKEN}` });
      expect(ok.statusCode).toBe(302);
      expect(ok.headers.location).toBe('/');
      const setCookie = String(ok.headers['set-cookie']);
      expect(setCookie).toContain(`hoopoe_launch=${TOKEN}`);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');

      const cookies = { hoopoe_launch: TOKEN };
      expect((await app.inject({ method: 'GET', url: '/health', cookies })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/accounts', cookies })).statusCode).toBe(200);

      // /api/mcp keeps its own auth: no cookie reaches the handler (401, not 403).
      const mcp = await app.inject({
        method: 'POST',
        url: '/api/mcp/rpc',
        payload: { user: 'nobody', nonce: 'AAAA', ct: 'AAAA' },
      });
      expect(mcp.statusCode).not.toBe(403);
    } finally {
      await app.close();
    }
  });

  it('without the env var: behaviour is unchanged', async () => {
    const app = await boot(undefined);
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
