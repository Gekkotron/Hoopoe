// A credential change must sign the user out everywhere else: before this,
// a session stolen (or simply left open on another device) survived a
// password change and a 2FA disable. Requires RUN_DB_TESTS=1.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN = process.env.RUN_DB_TESTS === '1' && process.env.AUTH_MODE !== 'none';
const d = RUN ? describe : describe.skip;

let app: FastifyInstance;

async function onboard(password: string): Promise<string> {
  const username = `revoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await app.inject({
    method: 'POST', url: '/api/onboarding/create', payload: { username, password },
  });
  expect(res.statusCode).toBe(201);
  return username;
}

async function login(username: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  const c = res.cookies[0]!;
  return `${c.name}=${c.value}`;
}

async function me(cookie: string): Promise<number> {
  return (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode;
}

d('session revocation on credential change', () => {
  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    app = await buildApp();
  });
  afterAll(async () => { await app.close(); });

  it('a password change signs out the other sessions and keeps the current one', async () => {
    const pw = 'revocation-old-pw';
    const user = await onboard(pw);
    const here = await login(user, pw);
    const elsewhere = await login(user, pw);
    const other = await login(await onboard(pw), pw);

    const res = await app.inject({
      method: 'PATCH', url: '/api/auth/me', headers: { cookie: here },
      payload: { currentPassword: pw, newPassword: 'revocation-new-pw' },
    });
    expect(res.statusCode).toBe(200);

    expect(await me(here)).toBe(200);
    expect(await me(elsewhere)).toBe(401);
    // Another user's session is untouched.
    expect(await me(other)).toBe(200);
  });

  it('a username-only change leaves the other sessions alone', async () => {
    const pw = 'revocation-rename-pw';
    const user = await onboard(pw);
    const here = await login(user, pw);
    const elsewhere = await login(user, pw);

    const res = await app.inject({
      method: 'PATCH', url: '/api/auth/me', headers: { cookie: here },
      payload: { currentPassword: pw, username: `${user}-renamed` },
    });
    expect(res.statusCode).toBe(200);
    expect(await me(elsewhere)).toBe(200);
  });

  it('disabling 2FA signs out the other sessions and keeps the current one', async () => {
    const pw = 'revocation-totp-pw';
    const user = await onboard(pw);
    const here = await login(user, pw);

    const enroll = await app.inject({
      method: 'POST', url: '/api/auth/2fa/enroll', headers: { cookie: here }, payload: { password: pw },
    });
    expect(enroll.statusCode).toBe(200);
    const { code } = (await app.inject({
      method: 'GET', url: '/api/auth/2fa/__debug/current-code', headers: { cookie: here },
    })).json();
    const confirm = await app.inject({
      method: 'POST', url: '/api/auth/2fa/confirm', headers: { cookie: here }, payload: { code },
    });
    expect(confirm.statusCode).toBe(200);
    const recovery: string[] = confirm.json().recoveryCodes;

    // A second device completes login with a recovery code.
    const pending = await login(user, pw);
    const verify = await app.inject({
      method: 'POST', url: '/api/auth/2fa/verify', headers: { cookie: pending },
      payload: { code: recovery[0] },
    });
    expect(verify.statusCode).toBe(200);
    const c = verify.cookies[0]!;
    const elsewhere = `${c.name}=${c.value}`;
    expect(await me(elsewhere)).toBe(200);

    const disable = await app.inject({
      method: 'POST', url: '/api/auth/2fa/disable', headers: { cookie: here },
      payload: { password: pw, code: recovery[1] },
    });
    expect(disable.statusCode).toBe(200);

    expect(await me(here)).toBe(200);
    expect(await me(elsewhere)).toBe(401);
  });
});
