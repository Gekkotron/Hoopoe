// requires Postgres + onboarding setup — run with RUN_DB_TESTS=1
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULTS } from '../src/domain/settings/defaults.js';

const RUN = !!process.env.RUN_DB_TESTS;
// GET never returns the channel secrets; it returns presence flags instead.
const { webhookUrl: _w, ...DEFAULT_DISCORD } = DEFAULTS.notifications.channels.discord;
const { apiKey: _a, ...DEFAULT_CALLMEBOT } = DEFAULTS.notifications.channels.callmebot;
void _w;
void _a;
const DEFAULT_NOTIFICATIONS = {
  ...DEFAULTS.notifications,
  channels: {
    ...DEFAULTS.notifications.channels,
    discord: { ...DEFAULT_DISCORD, hasWebhookUrl: false },
    callmebot: { ...DEFAULT_CALLMEBOT, hasApiKey: false },
  },
};
const HOOK = 'https://discord.com/api/webhooks/123/abc-DEF_9';

let app: FastifyInstance;
let cookie: string;

describe.skipIf(!RUN)('/api/settings', () => {
  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    app = await buildApp();

    await app.inject({
      method: 'POST', url: '/api/onboarding/create',
      payload: { username: 'settings', password: 'settings-1234' },
    });
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { username: 'settings', password: 'settings-1234' },
    });
    cookie = login.cookies[0]!.name + '=' + login.cookies[0]!.value;
  });

  afterEach(async () => {
    const { db } = await import('../src/db/client.js');
    const { userSettings } = await import('../src/db/schema.js');
    await db.delete(userSettings);
  });

  it('GET without auth returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('GET for a user with no row returns defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      dashboardRange: '3m',
      dashboardChartScope: 'all',
      chartGapThresholdDays: 6,
      duplicateSimilarityThreshold: 0,
      showForecast: false,
      transactionsDefaultAccount: 'first-checking',
      bankSyncHour: 2,
      backupHour: 3,
      displayCurrency: null,
      dashboardHiddenSections: [],
      notifications: DEFAULT_NOTIFICATIONS,
    });
  });

  it('PATCH with a partial upserts and returns the merged full object', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { dashboardRange: '12m', chartGapThresholdDays: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      dashboardRange: '12m',
      dashboardChartScope: 'all',
      chartGapThresholdDays: 10,
      duplicateSimilarityThreshold: 0,
      showForecast: false,
      transactionsDefaultAccount: 'first-checking',
      bankSyncHour: 2,
      backupHour: 3,
      displayCurrency: null,
      dashboardHiddenSections: [],
      notifications: DEFAULT_NOTIFICATIONS,
    });
  });

  it('two disjoint PATCHes merge (second GET reflects both)', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { dashboardRange: '6m' },
    });
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { duplicateSimilarityThreshold: 42 },
    });
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json().settings.dashboardRange).toBe('6m');
    expect(get.json().settings.duplicateSimilarityThreshold).toBe(42);
  });

  it('two disjoint notification PATCHes both survive (deep-merge, not JSONB shallow ||)', async () => {
    // Reproduces the Privacy tab bug: PATCH one privacy checkbox off,
    // then the other, and both should stick. Without the notifications
    // deep-merge, JSONB `||` at the top level wipes the whole
    // notifications subtree each time, so mergeSettings' fill-from-DEFAULTS
    // on GET silently flips the first one back to true.
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { notifications: { privacy: { hideAmount: false } } },
    });
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { notifications: { privacy: { hideMerchant: false } } },
    });
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json().settings.notifications.privacy).toEqual({
      hideAmount: false,
      hideMerchant: false,
    });
  });

  it('toggling a trigger enabled flag preserves the account-id thresholds map', async () => {
    // Same shallow-|| trap for per-account thresholds: patching just
    // `bigTransaction.enabled` must not wipe `bigTransaction.thresholds`.
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { notifications: { triggers: { bigTransaction: { thresholds: { '7': 500 } } } } },
    });
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { notifications: { triggers: { bigTransaction: { enabled: false } } } },
    });
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json().settings.notifications.triggers.bigTransaction).toEqual({
      enabled: false,
      thresholds: { '7': 500 },
    });
  });

  // The test DB is shared across files (no users truncate), so never take
  // "the first user" — resolve the logged-in one.
  async function myId(): Promise<number> {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    return me.json().user.id as number;
  }
  async function rawJson(): Promise<string> {
    const { db } = await import('../src/db/client.js');
    const { userSettings } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, await myId()));
    return JSON.stringify(rows.map((r) => r.settings));
  }
  const patch = (payload: unknown) =>
    app.inject({ method: 'PATCH', url: '/api/settings', headers: { cookie }, payload: payload as never });
  const get = () => app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });

  it('discord webhook is stored encrypted and never returned', async () => {
    const res = await patch({ notifications: { channels: { discord: { enabled: true, webhookUrl: HOOK } } } });
    expect(res.statusCode).toBe(200);
    for (const body of [res.body, (await get()).body]) {
      expect(body).not.toContain(HOOK);
      expect(body).not.toContain('webhookUrl"');
      expect(body).not.toContain('webhookUrlEnc');
    }
    expect((await get()).json().settings.notifications.channels.discord).toEqual({
      enabled: true, maxPerMinute: 0, hasWebhookUrl: true,
    });
    const raw = await rawJson();
    expect(raw).not.toContain(HOOK);
    expect(raw).toContain('webhookUrlEnc');
  });

  it('toggling enabled keeps the webhook; empty string clears it', async () => {
    await patch({ notifications: { channels: { discord: { enabled: true, webhookUrl: HOOK } } } });
    await patch({ notifications: { channels: { discord: { enabled: false } } } });
    let d = (await get()).json().settings.notifications.channels.discord;
    expect(d).toMatchObject({ enabled: false, hasWebhookUrl: true });
    await patch({ notifications: { channels: { discord: { webhookUrl: '' } } } });
    d = (await get()).json().settings.notifications.channels.discord;
    expect(d.hasWebhookUrl).toBe(false);
    expect(await rawJson()).not.toContain('webhookUrlEnc');
  });

  it('a patch to other notification fields keeps both secrets', async () => {
    await patch({ notifications: { channels: {
      discord: { webhookUrl: HOOK },
      callmebot: { phone: '+33612345678', apiKey: 'sekret-key' },
    } } });
    await patch({ notifications: { privacy: { hideAmount: false } } });
    const c = (await get()).json().settings.notifications.channels;
    expect(c.discord.hasWebhookUrl).toBe(true);
    expect(c.callmebot).toMatchObject({ phone: '+33612345678', hasApiKey: true });
  });

  it('callmebot apiKey: encrypted, never returned, kept on toggle, cleared by empty string', async () => {
    const res = await patch({ notifications: { channels: { callmebot: { enabled: true, phone: '+33612345678', apiKey: 'sekret-key' } } } });
    expect(res.body).not.toContain('sekret-key');
    expect(res.json().settings.notifications.channels.callmebot).toEqual({
      enabled: true, phone: '+33612345678', maxPerMinute: 0, hasApiKey: true,
    });
    const raw = await rawJson();
    expect(raw).not.toContain('sekret-key');
    expect(raw).toContain('apiKeyEnc');
    await patch({ notifications: { channels: { callmebot: { enabled: false } } } });
    expect((await get()).json().settings.notifications.channels.callmebot.hasApiKey).toBe(true);
    await patch({ notifications: { channels: { callmebot: { apiKey: '' } } } });
    expect((await get()).json().settings.notifications.channels.callmebot.hasApiKey).toBe(false);
    expect(await rawJson()).not.toContain('apiKeyEnc');
  });

  it('still rejects an invalid discord webhook URL', async () => {
    const res = await patch({ notifications: { channels: { discord: { webhookUrl: 'https://evil.example/x' } } } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects client-supplied *Enc keys (strict input schema)', async () => {
    const res = await patch({ notifications: { channels: { discord: { webhookUrlEnc: 'x' } } } });
    expect(res.statusCode).toBe(400);
  });

  it('a leftover legacy plaintext row reads as set and is not exposed', async () => {
    const { db } = await import('../src/db/client.js');
    const { userSettings } = await import('../src/db/schema.js');
    await db.insert(userSettings).values({
      userId: await myId(),
      settings: { notifications: { channels: { discord: { enabled: true, webhookUrl: HOOK, maxPerMinute: 0 } } } },
    });
    const res = await get();
    expect(res.body).not.toContain(HOOK);
    expect(res.json().settings.notifications.channels.discord.hasWebhookUrl).toBe(true);
    // A later unrelated patch seals it.
    await patch({ notifications: { privacy: { hideAmount: false } } });
    const raw = await rawJson();
    expect(raw).not.toContain(HOOK);
    expect(raw).toContain('webhookUrlEnc');
  });

  it('PATCH with an out-of-range value returns 400', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { chartGapThresholdDays: 999 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH with an unknown key returns 400 (strict schema)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { bogus: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH dashboardChartScope pointing to a deleted account sanitises to all on next GET', async () => {
    const tmp = await app.inject({
      method: 'POST', url: '/api/accounts', headers: { cookie },
      payload: { name: 'ToDelete', type: 'current', currency: 'EUR', openingBalance: '0', openingDate: '2025-01-01' },
    });
    const tmpId = tmp.json().account.id;
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { dashboardChartScope: tmpId },
    });
    await app.inject({ method: 'DELETE', url: `/api/accounts/${tmpId}`, headers: { cookie } });
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json().settings.dashboardChartScope).toBe('all');
  });

  it('PATCH transactionsDefaultAccount pointing to a deleted account sanitises to all on next GET', async () => {
    const tmp = await app.inject({
      method: 'POST', url: '/api/accounts', headers: { cookie },
      payload: { name: 'ToDelete', type: 'current', currency: 'EUR', openingBalance: '0', openingDate: '2025-01-01' },
    });
    const tmpId = tmp.json().account.id;
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { transactionsDefaultAccount: tmpId },
    });
    await app.inject({ method: 'DELETE', url: `/api/accounts/${tmpId}`, headers: { cookie } });
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json().settings.transactionsDefaultAccount).toBe('all');
  });

  it('PATCH dashboardChartScope pointing to another user\'s account sanitises to all', async () => {
    // Create a second user with their own account.
    // Log the first user out first so the onboarding endpoint stays disabled but
    // /api/auth/login lets us switch — actually onboarding refuses after the first
    // user is created; we side-step by inserting via db directly to keep the test
    // hermetic to route order.
    const { db } = await import('../src/db/client.js');
    const { users, accounts } = await import('../src/db/schema.js');
    const [otherUser] = await db.insert(users).values({
      username: 'other-user-settings',
      passwordHash: 'x',
    }).returning();
    const [otherAcc] = await db.insert(accounts).values({
      userId: otherUser!.id,
      name: 'Other',
      type: 'current',
      currency: 'EUR',
      openingBalance: '0',
      openingDate: '2025-01-01',
    }).returning();
    // Original user PATCHes their scope to the other user's account id.
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { dashboardChartScope: otherAcc!.id },
    });
    const get = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    expect(get.json().settings.dashboardChartScope).toBe('all');
    // Cleanup.
    const { eq } = await import('drizzle-orm');
    await db.delete(users).where(eq(users.id, otherUser!.id));
  });

  it('cascades on user deletion', async () => {
    await app.inject({
      method: 'PATCH', url: '/api/settings', headers: { cookie },
      payload: { dashboardRange: '6m' },
    });
    const { db } = await import('../src/db/client.js');
    const { users, userSettings } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    // Grab the user's id via the /me route.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    const uid = me.json().user.id;
    await db.delete(users).where(eq(users.id, uid));
    const rows = await db.select().from(userSettings).where(eq(userSettings.userId, uid));
    expect(rows).toHaveLength(0);
  });

  it('user_settings has a dismissed_tips column defaulting to {}', async () => {
    const { db } = await import('../src/db/client.js');
    const { eq } = await import('drizzle-orm');
    const { users, userSettings } = await import('../src/db/schema.js');

    const [u] = await db.insert(users).values({
      username: 'tips-smoke',
      passwordHash: 'x',
    }).returning();

    await db.insert(userSettings).values({ userId: u.id });
    const rows = await db.select().from(userSettings)
      .where(eq(userSettings.userId, u.id));
    expect(rows[0]?.dismissedTips).toEqual({});

    await db.delete(users).where(eq(users.id, u.id));
  });
});
