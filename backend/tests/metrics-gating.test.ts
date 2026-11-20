// /metrics exposure: disabled (404) by default, token-gated when
// METRICS_TOKEN is set, open only with an explicit METRICS_PUBLIC=true.
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Env, refreshEnvForTests } from '../src/env.js';

const TOKEN = 'metrics-token-0123456789abcdef';
const KEYS = ['METRICS_TOKEN', 'METRICS_PUBLIC'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let app: FastifyInstance | undefined;

async function buildWith(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  refreshEnvForTests();
  const { metricsPlugin } = await import('../src/http/plugins/metrics.js');
  app = Fastify({ logger: false });
  await app.register(metricsPlugin);
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  refreshEnvForTests();
});

describe('/metrics gating', () => {
  it('is not registered (404) when neither METRICS_TOKEN nor METRICS_PUBLIC is set', async () => {
    const a = await buildWith({});
    const res = await a.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    // Even a bearer header cannot enable it.
    const withAuth = await a.inject({
      method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(withAuth.statusCode).toBe(404);
  });

  it('keeps the metrics decoration when the route is disabled', async () => {
    const a = await buildWith({});
    expect(a.metrics).toBeDefined();
  });

  it('treats METRICS_PUBLIC=false as disabled', async () => {
    const a = await buildWith({ METRICS_PUBLIC: 'false' });
    const res = await a.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });

  it('serves /metrics without auth when METRICS_PUBLIC=true and no token', async () => {
    const a = await buildWith({ METRICS_PUBLIC: 'true' });
    const res = await a.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/# TYPE process_cpu_seconds_total counter/);
  });

  it('requires the bearer token when METRICS_TOKEN is set', async () => {
    const a = await buildWith({ METRICS_TOKEN: TOKEN });
    expect((await a.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const wrong = await a.inject({
      method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong-token-0123456789abcdef' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await a.inject({
      method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('lets the token win when both METRICS_TOKEN and METRICS_PUBLIC=true are set', async () => {
    const a = await buildWith({ METRICS_TOKEN: TOKEN, METRICS_PUBLIC: 'true' });
    expect((await a.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const ok = await a.inject({
      method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('METRICS_PUBLIC env parsing', () => {
  const parse = (extra: Record<string, string>) =>
    Env.safeParse({
      DB_DRIVER: 'pglite',
      SESSION_SECRET: 'a3f1c9e07b2d48e6a1c5f0b7d93e2a4c6b8d0f1e3a5c7e9b2d4f6a8c0e1b3d5f',
      ...extra,
    });

  it('defaults to false', () => {
    expect(parse({}).data?.METRICS_PUBLIC).toBe(false);
  });

  it('accepts true/1 and false/0', () => {
    expect(parse({ METRICS_PUBLIC: 'true' }).data?.METRICS_PUBLIC).toBe(true);
    expect(parse({ METRICS_PUBLIC: '1' }).data?.METRICS_PUBLIC).toBe(true);
    expect(parse({ METRICS_PUBLIC: 'false' }).data?.METRICS_PUBLIC).toBe(false);
    expect(parse({ METRICS_PUBLIC: '0' }).data?.METRICS_PUBLIC).toBe(false);
  });

  it('rejects other values', () => {
    expect(parse({ METRICS_PUBLIC: 'yes' }).success).toBe(false);
  });

  // docker-compose passes an unset METRICS_TOKEN as '' — that must mean
  // "no token", not fail the min(16) check and refuse to boot.
  it('treats an empty METRICS_TOKEN as unset', () => {
    const r = parse({ METRICS_TOKEN: '' });
    expect(r.success).toBe(true);
    expect(r.data?.METRICS_TOKEN).toBeUndefined();
  });
});
