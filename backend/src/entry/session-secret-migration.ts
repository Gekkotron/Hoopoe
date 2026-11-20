import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { totpKey, encryptTotpSecret, decryptTotpSecret } from '../domain/auth/totp-crypto.js';
import { bankSyncKey, encryptPrivateKey, decryptPrivateKey } from '../domain/bank-sync/crypto.js';
import { backupSecretsKey, encryptSecret, decryptSecret } from '../domain/backup/secrets.js';
import {
  notificationSecretsKey,
  encryptNotificationSecret,
  decryptNotificationSecret,
  readNotificationSecretState,
  rawChannel,
} from '../domain/notifications/secrets.js';
import { masterKey, wrapKey, unwrapKey } from '../domain/mcp/crypto.js';

export type SessionSecretMigrationCounts = {
  userTotp: number;
  bankSyncCredentials: number;
  backupDestinations: number;
  mcpKeys: number;
  notificationSecrets: number;
};

// Re-encrypts every SESSION_SECRET-derived field-crypto row in place, in a
// single transaction. Called at first Tauri boot after the upgrade that
// swapped the hardcoded constant for a per-install random secret. Failure
// mode: the transaction rolls back — no partial state, so on the next boot
// the old constant still decrypts everything and we can try again.
export async function migrateSessionSecret(
  oldSecret: string,
  newSecret: string,
): Promise<SessionSecretMigrationCounts> {
  const oldTotp = totpKey(oldSecret);
  const newTotp = totpKey(newSecret);
  const oldBank = bankSyncKey(oldSecret);
  const newBank = bankSyncKey(newSecret);
  const oldBackup = backupSecretsKey(oldSecret);
  const newBackup = backupSecretsKey(newSecret);
  const oldMk = masterKey(oldSecret);
  const newMk = masterKey(newSecret);
  const oldNotif = notificationSecretsKey(oldSecret);
  const newNotif = notificationSecretsKey(newSecret);

  return db.transaction(async (tx) => {
    const counts: SessionSecretMigrationCounts = {
      userTotp: 0,
      bankSyncCredentials: 0,
      backupDestinations: 0,
      mcpKeys: 0,
      notificationSecrets: 0,
    };

    const totpRows = await tx.execute<{ user_id: number; secret_ciphertext: string }>(
      sql`SELECT user_id, secret_ciphertext FROM user_totp`,
    );
    for (const row of totpRows.rows) {
      const plain = decryptTotpSecret(oldTotp, row.user_id, row.secret_ciphertext);
      const reenc = encryptTotpSecret(newTotp, row.user_id, plain);
      await tx.execute(
        sql`UPDATE user_totp SET secret_ciphertext = ${reenc} WHERE user_id = ${row.user_id}`,
      );
      counts.userTotp++;
    }

    const bankRows = await tx.execute<{ user_id: number; private_key_encrypted: string }>(
      sql`SELECT user_id, private_key_encrypted FROM bank_sync_credentials`,
    );
    for (const row of bankRows.rows) {
      const plain = decryptPrivateKey(oldBank, row.user_id, row.private_key_encrypted);
      const reenc = encryptPrivateKey(newBank, row.user_id, plain);
      await tx.execute(
        sql`UPDATE bank_sync_credentials SET private_key_encrypted = ${reenc} WHERE user_id = ${row.user_id}`,
      );
      counts.bankSyncCredentials++;
    }

    const backupRows = await tx.execute<{
      user_id: number;
      secret_encrypted: string | null;
      passphrase_encrypted: string;
    }>(
      sql`SELECT user_id, secret_encrypted, passphrase_encrypted FROM backup_destinations`,
    );
    for (const row of backupRows.rows) {
      const nextSecret = row.secret_encrypted
        ? encryptSecret(
            newBackup,
            row.user_id,
            'secret',
            decryptSecret(oldBackup, row.user_id, 'secret', row.secret_encrypted),
          )
        : null;
      const nextPassphrase = encryptSecret(
        newBackup,
        row.user_id,
        'passphrase',
        decryptSecret(oldBackup, row.user_id, 'passphrase', row.passphrase_encrypted),
      );
      await tx.execute(
        sql`UPDATE backup_destinations
            SET secret_encrypted = ${nextSecret}, passphrase_encrypted = ${nextPassphrase}
            WHERE user_id = ${row.user_id}`,
      );
      counts.backupDestinations++;
    }

    const mcpRows = await tx.execute<{ user_id: number; mcp_key_wrapped: string }>(
      sql`SELECT user_id, mcp_key_wrapped FROM user_settings WHERE mcp_key_wrapped IS NOT NULL`,
    );
    for (const row of mcpRows.rows) {
      const k = unwrapKey(oldMk, row.mcp_key_wrapped);
      const rewrapped = wrapKey(newMk, k);
      await tx.execute(
        sql`UPDATE user_settings SET mcp_key_wrapped = ${rewrapped} WHERE user_id = ${row.user_id}`,
      );
      counts.mcpKeys++;
    }

    // Discord webhook URL / CallMeBot key live inside the settings JSONB.
    const notifRows = await tx.execute<{ user_id: number; settings: unknown }>(sql`
      SELECT user_id, settings FROM user_settings
      WHERE settings #> '{notifications,channels,discord}' ? 'webhookUrlEnc'
         OR settings #> '{notifications,channels,callmebot}' ? 'apiKeyEnc'
    `);
    for (const row of notifRows.rows) {
      const s = readNotificationSecretState(row.settings);
      const targets = [
        { channel: 'discord', encKey: 'webhookUrlEnc', enc: s.discordEnc, field: 'discordWebhookUrl' },
        { channel: 'callmebot', encKey: 'apiKeyEnc', enc: s.callmebotEnc, field: 'callmebotApiKey' },
      ] as const;
      for (const t of targets) {
        if (!t.enc) continue;
        const reenc = encryptNotificationSecret(
          newNotif,
          row.user_id,
          t.field,
          decryptNotificationSecret(oldNotif, row.user_id, t.field, t.enc),
        );
        const next = { ...rawChannel(row.settings, t.channel), [t.encKey]: reenc };
        await tx.execute(sql`UPDATE user_settings
          SET settings = jsonb_set(settings, ${`{notifications,channels,${t.channel}}`}::text[], ${JSON.stringify(next)}::jsonb)
          WHERE user_id = ${row.user_id}`);
      }
      counts.notificationSecrets++;
    }

    return counts;
  });
}

// Docker / server path: operator-driven rotation. When SESSION_SECRET_PREVIOUS
// is set and differs from SESSION_SECRET, re-encrypt everything from the old
// key to the new one. Returns null when there is nothing to do. Throws (and
// rolls back) when a row does not decrypt under `previous` — typically
// because an earlier boot already rotated and the variable was left set.
export async function rotateFromPreviousSecret(
  previous: string | undefined,
  current: string,
): Promise<SessionSecretMigrationCounts | null> {
  if (!previous || previous === current) return null;
  return migrateSessionSecret(previous, current);
}
