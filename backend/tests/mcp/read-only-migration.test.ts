import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const RUN = !!process.env.RUN_DB_TESTS;

// 0051 adds user_settings.mcp_read_only DEFAULT true and backfills false for
// anyone already using MCP. Rows seeded after the migration cannot be "old"
// rows, so the backfill UPDATE is extracted from the SQL file and re-run
// against rows reset to the column default.
describe.skipIf(!RUN)('0051_mcp_read_only migration', () => {
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    const { runMigrations } = await import('../../src/db/migrate.js');
    await runMigrations();
    const { db } = await import('../../src/db/client.js');
    const { users, userSettings } = await import('../../src/db/schema.js');
    await db.delete(userSettings);
    await db.delete(users);
    for (const name of ['enabled', 'tokenonly', 'neither']) {
      const [u] = await db.insert(users).values({ username: `ro-${name}`, passwordHash: 'x' }).returning();
      ids[name] = u!.id;
    }
    await db.insert(userSettings).values([
      { userId: ids.enabled!, mcpEnabled: true },
      { userId: ids.tokenonly!, mcpKeyWrapped: 'W' },
      { userId: ids.neither! },
    ]);
  });
  afterAll(async () => {
    const { db } = await import('../../src/db/client.js');
    const { users, userSettings } = await import('../../src/db/schema.js');
    await db.delete(userSettings);
    await db.delete(users);
  });

  it('new rows default to read-only', async () => {
    const { db } = await import('../../src/db/client.js');
    const { userSettings } = await import('../../src/db/schema.js');
    const rows = await db.select().from(userSettings);
    expect(rows.every((r) => r.mcpReadOnly === true)).toBe(true);
  });

  it('backfill keeps write access for existing MCP users only', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(path.resolve(here, '../../src/db/migrations/0051_mcp_read_only.sql'), 'utf8');
    const update = sql.match(/UPDATE user_settings[\s\S]*?;/)?.[0];
    expect(update).toBeTruthy();
    const { pool, db } = await import('../../src/db/client.js');
    await pool.query(update!);

    const { userSettings } = await import('../../src/db/schema.js');
    const byUser = Object.fromEntries((await db.select().from(userSettings)).map((r) => [r.userId, r.mcpReadOnly]));
    expect(byUser[ids.enabled!]).toBe(false);
    expect(byUser[ids.tokenonly!]).toBe(false);
    expect(byUser[ids.neither!]).toBe(true);
  });
});
