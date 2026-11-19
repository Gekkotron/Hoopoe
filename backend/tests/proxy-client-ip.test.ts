// Per-client rate limiting behind the Docker nginx. Before TRUST_PROXY
// existed, Fastify keyed every limit on the socket address — the nginx
// container — so one device's failed logins throttled every browser on the
// LAN, and per-client throttling was lost. These tests drive the strictest
// public bucket (/api/onboarding/create, 5/min, not raised under test) with
// an invalid body so the handler answers 400 before touching the DB.
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { refreshEnvForTests } from '../src/env.js';

const NGINX = '172.18.0.3';
const savedTrustProxy = process.env.TRUST_PROXY;
let app: FastifyInstance | undefined;

async function buildWith(trustProxy: string | undefined): Promise<FastifyInstance> {
  if (trustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = trustProxy;
  refreshEnvForTests();
  const { buildApp } = await import('./helpers/build-app.js');
  app = await buildApp();
  return app;
}

function hit(a: FastifyInstance, remoteAddress: string, forwardedFor?: string) {
  return a.inject({
    method: 'POST',
    url: '/api/onboarding/create',
    remoteAddress,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    payload: {},
  });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = savedTrustProxy;
  refreshEnvForTests();
});

describe('client IP behind nginx (TRUST_PROXY=loopback,uniquelocal)', () => {
  it('throttles each browser separately instead of the shared nginx hop', async () => {
    const a = await buildWith('loopback,uniquelocal');
    for (let i = 0; i < 5; i++) {
      expect((await hit(a, NGINX, '192.168.1.10')).statusCode).toBe(400);
    }
    expect((await hit(a, NGINX, '192.168.1.10')).statusCode).toBe(429);
    // A second device behind the same nginx keeps its own budget.
    expect((await hit(a, NGINX, '192.168.1.11')).statusCode).toBe(400);
  });

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', async () => {
    const a = await buildWith('loopback,uniquelocal');
    // A public peer cannot rotate forged addresses to dodge the limit.
    for (let i = 0; i < 5; i++) {
      expect((await hit(a, '203.0.113.7', `198.51.100.${i}`)).statusCode).toBe(400);
    }
    expect((await hit(a, '203.0.113.7', '198.51.100.99')).statusCode).toBe(429);
  });
});

describe('client IP without a proxy (TRUST_PROXY unset)', () => {
  it('keys on the socket address and ignores X-Forwarded-For', async () => {
    const a = await buildWith(undefined);
    for (let i = 0; i < 5; i++) {
      expect((await hit(a, '127.0.0.1', `10.0.0.${i}`)).statusCode).toBe(400);
    }
    expect((await hit(a, '127.0.0.1', '10.0.0.99')).statusCode).toBe(429);
  });
});
