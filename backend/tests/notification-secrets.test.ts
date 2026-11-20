import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  notificationSecretsKey,
  encryptNotificationSecret,
  decryptNotificationSecret,
} from '../src/domain/notifications/secrets.js';

const URL1 = 'https://discord.com/api/webhooks/123/abc-DEF_9';

describe('notification secrets crypto', () => {
  const key = notificationSecretsKey('a'.repeat(40));

  it('roundtrips', () => {
    const enc = encryptNotificationSecret(key, 1, 'discordWebhookUrl', URL1);
    expect(enc).not.toContain('discord');
    expect(decryptNotificationSecret(key, 1, 'discordWebhookUrl', enc)).toBe(URL1);
  });

  it('fails for another user id', () => {
    const enc = encryptNotificationSecret(key, 1, 'discordWebhookUrl', URL1);
    expect(() => decryptNotificationSecret(key, 2, 'discordWebhookUrl', enc)).toThrow();
  });

  it('fails when the field is swapped', () => {
    const enc = encryptNotificationSecret(key, 1, 'callmebotApiKey', 'k');
    expect(() => decryptNotificationSecret(key, 1, 'discordWebhookUrl', enc)).toThrow();
  });

  it('fails under a different session secret', () => {
    const enc = encryptNotificationSecret(key, 1, 'callmebotApiKey', 'k');
    expect(() =>
      decryptNotificationSecret(notificationSecretsKey('b'.repeat(40)), 1, 'callmebotApiKey', enc),
    ).toThrow();
  });
});

const RUN = !!process.env.RUN_DB_TESTS;

describe.skipIf(!RUN)('notification secrets (db)', () => {
  let uid: number;

  async function rawSettings(): Promise<any> {
    const { db } = await import('../src/db/client.js');
    const { userSettings } = await import('../src/db/schema.js');
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, uid));
    return row?.settings;
  }

  async function setRaw(settings: unknown): Promise<void> {
    const { db } = await import('../src/db/client.js');
    const { userSettings } = await import('../src/db/schema.js');
    await db
      .insert(userSettings)
      .values({ userId: uid, settings: settings as never })
      .onConflictDoUpdate({ target: userSettings.userId, set: { settings: settings as never } });
  }

  beforeEach(async () => {
    const { seedUser } = await import('./helpers/seedUser.js');
    uid = await seedUser();
  });

  it('legacy pass encrypts plaintext, removes it, and is idempotent', async () => {
    const { env } = await import('../src/env.js');
    const { encryptLegacyNotificationSecrets, readNotificationSecretState } = await import(
      '../src/domain/notifications/secrets.js'
    );
    await setRaw({
      notifications: {
        enabled: true,
        channels: {
          discord: { enabled: true, webhookUrl: URL1, maxPerMinute: 3 },
          callmebot: { enabled: true, phone: '+33600000000', apiKey: 'key-123', maxPerMinute: 0 },
        },
      },
    });

    await encryptLegacyNotificationSecrets();
    const after = await rawSettings();
    expect(JSON.stringify(after)).not.toContain(URL1);
    expect(JSON.stringify(after)).not.toContain('key-123');
    expect(after.notifications.channels.discord.webhookUrl).toBeUndefined();
    expect(after.notifications.channels.discord.maxPerMinute).toBe(3);
    expect(after.notifications.channels.callmebot.phone).toBe('+33600000000');
    const s = readNotificationSecretState(after);
    const key = notificationSecretsKey(env.SESSION_SECRET);
    expect(decryptNotificationSecret(key, uid, 'discordWebhookUrl', s.discordEnc)).toBe(URL1);
    expect(decryptNotificationSecret(key, uid, 'callmebotApiKey', s.callmebotEnc)).toBe('key-123');

    // Second run: nothing to rewrite, ciphertext unchanged.
    const again = await encryptLegacyNotificationSecrets();
    expect(again).toBe(0);
    expect(await rawSettings()).toEqual(after);
  });

  it('legacy pass drops empty plaintext without creating ciphertext', async () => {
    const { encryptLegacyNotificationSecrets } = await import('../src/domain/notifications/secrets.js');
    await setRaw({ notifications: { channels: { discord: { enabled: false, webhookUrl: '' } } } });
    await encryptLegacyNotificationSecrets();
    const after = await rawSettings();
    expect(after.notifications.channels.discord).toEqual({ enabled: false });
  });

  it('dispatch decrypts and sends to the plaintext URL', async () => {
    const { db } = await import('../src/db/client.js');
    const { env } = await import('../src/env.js');
    const { emitNotification } = await import('../src/domain/notifications/emit.js');
    const { __setDiscordFetchForTests, __resetDiscordRateLimitForTests } = await import(
      '../src/domain/notifications/channels/discord.js'
    );
    void db;
    __resetDiscordRateLimitForTests();
    const key = notificationSecretsKey(env.SESSION_SECRET);
    await setRaw({
      notifications: {
        enabled: true,
        channels: {
          discord: {
            enabled: true,
            maxPerMinute: 0,
            webhookUrlEnc: encryptNotificationSecret(key, uid, 'discordWebhookUrl', URL1),
          },
        },
      },
    });
    const calls: string[] = [];
    const prev = __setDiscordFetchForTests((async (u: unknown) => {
      calls.push(String(u));
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch);
    try {
      await emitNotification(uid, 'test', { kind: 'test' }, { idempotency: 'ns-1' });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      __setDiscordFetchForTests(prev);
    }
    expect(calls).toEqual([URL1]);
  });

  it('dispatch with an undecryptable secret skips the channel and does not throw', async () => {
    const { emitNotification } = await import('../src/domain/notifications/emit.js');
    const { __setDiscordFetchForTests, __resetDiscordRateLimitForTests } = await import(
      '../src/domain/notifications/channels/discord.js'
    );
    __resetDiscordRateLimitForTests();
    const wrong = notificationSecretsKey(randomBytes(32).toString('hex'));
    await setRaw({
      notifications: {
        enabled: true,
        channels: {
          discord: {
            enabled: true,
            webhookUrlEnc: encryptNotificationSecret(wrong, uid, 'discordWebhookUrl', URL1),
          },
        },
      },
    });
    const calls: string[] = [];
    const prev = __setDiscordFetchForTests((async (u: unknown) => {
      calls.push(String(u));
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch);
    try {
      const out = await emitNotification(uid, 'test', { kind: 'test' }, { idempotency: 'ns-2' });
      expect(out).not.toBeNull();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      __setDiscordFetchForTests(prev);
    }
    expect(calls).toEqual([]);
  });

  it('SESSION_SECRET rotation re-encrypts the notification ciphertexts', async () => {
    const { migrateSessionSecret } = await import('../src/entry/session-secret-migration.js');
    const { db } = await import('../src/db/client.js');
    const { userTotp, bankSyncCredentials, backupDestinations } = await import('../src/db/schema.js');
    const { readNotificationSecretState } = await import('../src/domain/notifications/secrets.js');
    await db.delete(userTotp);
    await db.delete(bankSyncCredentials);
    await db.delete(backupDestinations);
    await db.execute(sql`UPDATE user_settings SET settings = '{}'::jsonb WHERE user_id <> ${uid}`);
    const OLD = randomBytes(32).toString('hex');
    const NEW = randomBytes(32).toString('hex');
    const ko = notificationSecretsKey(OLD);
    await setRaw({
      notifications: {
        channels: {
          discord: { enabled: true, webhookUrlEnc: encryptNotificationSecret(ko, uid, 'discordWebhookUrl', URL1) },
          callmebot: { enabled: true, apiKeyEnc: encryptNotificationSecret(ko, uid, 'callmebotApiKey', 'k9') },
        },
      },
    });
    const counts = await migrateSessionSecret(OLD, NEW);
    expect(counts.notificationSecrets).toBe(1);
    const s = readNotificationSecretState(await rawSettings());
    const kn = notificationSecretsKey(NEW);
    expect(decryptNotificationSecret(kn, uid, 'discordWebhookUrl', s.discordEnc)).toBe(URL1);
    expect(decryptNotificationSecret(kn, uid, 'callmebotApiKey', s.callmebotEnc)).toBe('k9');
    expect(() => decryptNotificationSecret(ko, uid, 'discordWebhookUrl', s.discordEnc)).toThrow();
  });
});
