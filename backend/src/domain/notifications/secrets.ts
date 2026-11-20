import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { env } from '../../env.js';

// Encryption at rest for the two notification-channel secrets: the Discord
// webhook URL and the CallMeBot API key. Same construction as
// domain/backup/secrets.ts: AES-256-GCM under a key derived from
// SESSION_SECRET via HKDF-SHA256, with the owning user id AND the field name
// bound as AAD, so a ciphertext copied to another user or swapped between
// the two fields fails authentication.
//
// Storage shape inside user_settings.settings (internal, never exposed):
//   notifications.channels.discord.webhookUrlEnc  (base64 nonce||ct||tag)
//   notifications.channels.callmebot.apiKeyEnc
// The plaintext `webhookUrl` / `apiKey` keys only exist on legacy rows until
// encryptLegacyNotificationSecrets() runs at boot.

const HKDF_SALT = 'hoopoe-notification-secrets-v1';
const HKDF_INFO = 'secrets-key';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type NotificationSecretField = 'discordWebhookUrl' | 'callmebotApiKey';

export function notificationSecretsKey(sessionSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(sessionSecret, 'utf8'), Buffer.from(HKDF_SALT), Buffer.from(HKDF_INFO), 32),
  );
}

function aad(userId: number, field: NotificationSecretField): Buffer {
  return Buffer.from(`notification-channel:${userId}:${field}`, 'utf8');
}

export function encryptNotificationSecret(
  key: Buffer,
  userId: number,
  field: NotificationSecretField,
  plaintext: string,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(userId, field));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, enc, cipher.getAuthTag()]).toString('base64');
}

export function decryptNotificationSecret(
  key: Buffer,
  userId: number,
  field: NotificationSecretField,
  stored: string,
): string {
  const buf = Buffer.from(stored, 'base64');
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const enc = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad(userId, field));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// The raw stored channel object (`discord` / `callmebot`), or {} when absent.
export function rawChannel(rawSettings: unknown, channel: 'discord' | 'callmebot'): Obj {
  if (!isObj(rawSettings)) return {};
  const n = rawSettings.notifications;
  if (!isObj(n) || !isObj(n.channels)) return {};
  const c = n.channels[channel];
  return isObj(c) ? c : {};
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export type NotificationSecretState = {
  /** Stored ciphertext, when present. */
  discordEnc: string;
  callmebotEnc: string;
  /** Leftover plaintext from before encryption at rest (legacy rows). */
  discordLegacy: string;
  callmebotLegacy: string;
};

export function readNotificationSecretState(rawSettings: unknown): NotificationSecretState {
  const d = rawChannel(rawSettings, 'discord');
  const c = rawChannel(rawSettings, 'callmebot');
  return {
    discordEnc: str(d.webhookUrlEnc),
    callmebotEnc: str(c.apiKeyEnc),
    discordLegacy: str(d.webhookUrl).trim(),
    callmebotLegacy: str(c.apiKey).trim(),
  };
}

export function hasWebhookUrl(rawSettings: unknown): boolean {
  const s = readNotificationSecretState(rawSettings);
  return s.discordEnc !== '' || s.discordLegacy !== '';
}

export function hasApiKey(rawSettings: unknown): boolean {
  const s = readNotificationSecretState(rawSettings);
  return s.callmebotEnc !== '' || s.callmebotLegacy !== '';
}

type Warn = { warn: (o: unknown, msg?: string) => void };

// Plaintext secrets for the sending path. A ciphertext that fails to
// decrypt (SESSION_SECRET changed without rotation) yields '' so the
// channel counts as not configured, never a crash.
export function resolveNotificationSecrets(
  userId: number,
  rawSettings: unknown,
  log?: Warn,
): { webhookUrl: string; apiKey: string } {
  const s = readNotificationSecretState(rawSettings);
  const key = notificationSecretsKey(env.SESSION_SECRET);
  const open = (enc: string, legacy: string, field: NotificationSecretField): string => {
    if (enc) {
      try {
        return decryptNotificationSecret(key, userId, field, enc);
      } catch {
        (log ?? console).warn({ userId, field }, 'notification_secret_undecryptable');
        return '';
      }
    }
    return legacy;
  };
  return {
    webhookUrl: open(s.discordEnc, s.discordLegacy, 'discordWebhookUrl'),
    apiKey: open(s.callmebotEnc, s.callmebotLegacy, 'callmebotApiKey'),
  };
}

// One-shot, idempotent boot pass: encrypts any legacy plaintext webhookUrl /
// apiKey in every user_settings row and drops the plaintext key. Rows that
// are already clean are not touched. Returns the number of rows rewritten.
export async function encryptLegacyNotificationSecrets(
  sessionSecret: string = env.SESSION_SECRET,
): Promise<number> {
  const key = notificationSecretsKey(sessionSecret);
  const rows = await db.execute<{ user_id: number; settings: unknown }>(sql`
    SELECT user_id, settings FROM user_settings
    WHERE settings #> '{notifications,channels,discord}' ? 'webhookUrl'
       OR settings #> '{notifications,channels,callmebot}' ? 'apiKey'
  `);
  let n = 0;
  for (const row of rows.rows) {
    const s = readNotificationSecretState(row.settings);
    const targets: Array<{
      channel: 'discord' | 'callmebot';
      plainKey: string;
      encKey: string;
      enc: string;
      legacy: string;
      field: NotificationSecretField;
    }> = [
      { channel: 'discord', plainKey: 'webhookUrl', encKey: 'webhookUrlEnc', enc: s.discordEnc, legacy: s.discordLegacy, field: 'discordWebhookUrl' },
      { channel: 'callmebot', plainKey: 'apiKey', encKey: 'apiKeyEnc', enc: s.callmebotEnc, legacy: s.callmebotLegacy, field: 'callmebotApiKey' },
    ];
    for (const t of targets) {
      const current = rawChannel(row.settings, t.channel);
      if (!(t.plainKey in current)) continue;
      const rest: Obj = { ...current };
      delete rest[t.plainKey];
      // An existing ciphertext wins over a stray plaintext copy.
      const nextEnc = t.enc || (t.legacy ? encryptNotificationSecret(key, row.user_id, t.field, t.legacy) : '');
      if (nextEnc) rest[t.encKey] = nextEnc;
      await db.execute(sql`UPDATE user_settings
        SET settings = jsonb_set(settings, ${`{notifications,channels,${t.channel}}`}::text[], ${JSON.stringify(rest)}::jsonb)
        WHERE user_id = ${row.user_id}`);
    }
    n++;
  }
  return n;
}
