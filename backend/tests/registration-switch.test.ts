// ALLOW_REGISTRATION: once a user exists, /api/onboarding/create only
// accepts new accounts when the switch is on (the default). The very first
// account is always allowed, otherwise a fresh install could never be set
// up. Requires RUN_DB_TESTS=1.
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { refreshEnvForTests } from '../src/env.js';

const RUN = process.env.RUN_DB_TESTS === '1';
const d = RUN ? describe : describe.skip;

const savedAllow = process.env.ALLOW_REGISTRATION;
let app: FastifyInstance | undefined;

async function buildWith(allow: string | undefined): Promise<FastifyInstance> {
  if (allow === undefined) delete process.env.ALLOW_REGISTRATION;
  else process.env.ALLOW_REGISTRATION = allow;
  refreshEnvForTests();
  const { buildApp } = await import('./helpers/build-app.js');
  app = await buildApp();
  return app;
}

function register(a: FastifyInstance) {
  return a.inject({
    method: 'POST',
    url: '/api/onboarding/create',
    payload: {
      username: `reg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      password: 'registration-switch-pw',
    },
  });
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (savedAllow === undefined) delete process.env.ALLOW_REGISTRATION;
  else process.env.ALLOW_REGISTRATION = savedAllow;
  refreshEnvForTests();
});

d('ALLOW_REGISTRATION', () => {
  it('stays open by default once a user exists', async () => {
    const { seedUser } = await import('./helpers/seedUser.js');
    await seedUser();
    const a = await buildWith(undefined);

    const status = await a.inject({ method: 'GET', url: '/api/onboarding/status' });
    expect(status.json()).toEqual({ needsOnboarding: false, registrationOpen: true });
    expect((await register(a)).statusCode).toBe(201);
  });

  it('refuses new accounts when false and a user exists', async () => {
    const { seedUser } = await import('./helpers/seedUser.js');
    await seedUser();
    const a = await buildWith('false');

    const status = await a.inject({ method: 'GET', url: '/api/onboarding/status' });
    expect(status.json()).toEqual({ needsOnboarding: false, registrationOpen: false });

    const res = await register(a);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'registration_closed' });
  });

  it('still lets the first account through when false', async () => {
    const { db } = await import('../src/db/client.js');
    const { users } = await import('../src/db/schema.js');
    await db.delete(users);
    const a = await buildWith('false');

    const status = await a.inject({ method: 'GET', url: '/api/onboarding/status' });
    expect(status.json()).toEqual({ needsOnboarding: true, registrationOpen: true });
    expect((await register(a)).statusCode).toBe(201);
    // ...and only the first one.
    expect((await register(a)).statusCode).toBe(403);
  });
});
