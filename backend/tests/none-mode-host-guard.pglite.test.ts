// In AUTH_MODE=none every request is the local user, so build() must refuse
// any Host that is not a loopback name (DNS rebinding). Session mode must not
// apply that check. Boot pattern mirrors security-routes.pglite.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refreshEnvForTests } from '../src/env.js';

const KEYS = ['DB_DRIVER', 'AUTH_MODE', 'SESSION_SECRET', 'DATA_DIR', 'PGLITE_PATH'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string>> = {};
for (const k of KEYS) if (process.env[k] !== undefined) saved[k] = process.env[k];

let tmp: string;

async function boot(mode: 'none' | 'session'): Promise<FastifyInstance> {
  process.env.AUTH_MODE = mode;
  refreshEnvForTests();
  const { runMigrations } = await import('../src/db/migrate.js');
  const { ensureLocalUser } = await import('../src/domain/auth/localUser.js');
  const { build } = await import('../src/buildServer.js');
  await runMigrations();
  await ensureLocalUser();
  return build({ logger: false });
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'hoopoe-host-'));
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

describe('Host guard', () => {
  it('none mode: rejects foreign Hosts with 403, serves loopback Hosts', async () => {
    const app = await boot('none');
    try {
      for (const host of ['evil.example', '127.0.0.1.evil.example', '192.168.1.10:8001']) {
        const res = await app.inject({ method: 'GET', url: '/health', headers: { host } });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden host' });
      }
      const api = await app.inject({ method: 'GET', url: '/api/accounts', headers: { host: 'evil.example' } });
      expect(api.statusCode).toBe(403);
      for (const host of ['127.0.0.1:5555', 'localhost', '[::1]:9']) {
        const ok = await app.inject({ method: 'GET', url: '/health', headers: { host } });
        expect(ok.statusCode).toBe(200);
      }
      // inject() default Host (localhost:80) keeps working.
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('session mode: foreign Host is not rejected by the hook', async () => {
    const app = await boot('session');
    try {
      const res = await app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example' } });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
