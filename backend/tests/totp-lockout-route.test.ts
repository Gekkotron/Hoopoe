// /api/auth/2fa/verify had only the per-IP limit, so someone with the
// password could rotate addresses and keep guessing codes. After 5 wrong
// codes the account is locked for 15 minutes from any address, and even a
// correct code is refused meanwhile. Requires RUN_DB_TESTS=1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN = process.env.RUN_DB_TESTS === '1' && process.env.AUTH_MODE !== 'none';
const d = RUN ? describe : describe.skip;

let app: FastifyInstance;

d('2FA per-account lockout', () => {
  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    app = await buildApp();
  });
  afterAll(async () => { await app.close(); });

  it('locks the account after 5 wrong codes, across client addresses', async () => {
    const { generateCode } = await import('../src/domain/auth/totp.js');
    const username = `lockout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const password = 'lockout-test-pw-1';
    await app.inject({ method: 'POST', url: '/api/onboarding/create', payload: { username, password } });

    const login = async (remoteAddress: string) => {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/login', remoteAddress, payload: { username, password },
      });
      const c = res.cookies[0]!;
      return `${c.name}=${c.value}`;
    };

    const setup = await login('10.0.0.1');
    const { secret } = (await app.inject({
      method: 'POST', url: '/api/auth/2fa/enroll', headers: { cookie: setup }, payload: { password },
    })).json();
    const confirm = await app.inject({
      method: 'POST', url: '/api/auth/2fa/confirm', headers: { cookie: setup },
      payload: { code: generateCode(secret) },
    });
    expect(confirm.statusCode).toBe(200);

    const pending = await login('10.0.0.2');
    const wrong = generateCode(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/2fa/verify', remoteAddress: `10.0.1.${i}`,
        headers: { cookie: pending }, payload: { code: wrong },
      });
      expect(res.statusCode).toBe(401);
    }

    // Fresh session, fresh address, a recovery code that would be valid.
    const recovery: string[] = confirm.json().recoveryCodes;
    const again = await login('10.0.0.3');
    const locked = await app.inject({
      method: 'POST', url: '/api/auth/2fa/verify', remoteAddress: '10.0.2.1',
      headers: { cookie: again }, payload: { code: recovery[0] },
    });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    // ...and the recovery code was not spent by the refused attempt.
    const status = await app.inject({
      method: 'GET', url: '/api/auth/2fa/status', headers: { cookie: setup },
    });
    expect(status.json().remainingRecoveryCodes).toBe(10);
  });
});
