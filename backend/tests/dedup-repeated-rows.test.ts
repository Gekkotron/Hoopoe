// requires Postgres (or DB_DRIVER=pglite) — run with RUN_DB_TESTS=1
//
// Two real transactions can share account, date, amount and label (two
// coffees on the same day). Without a FITID they used to hash to the same
// dedup key and the second one was silently dropped. These tests cover the
// occurrence-numbered keys end to end.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN = !!process.env.RUN_DB_TESTS;

const TWO_COFFEES = 'Date;Libellé;Montant\n15/06/2026;CAFE DU COIN;-2,50\n15/06/2026;CAFE DU COIN;-2,50\n16/06/2026;BOULANGERIE;-1,20\n';

let app: FastifyInstance;
let cookie: string;
let uid: number;
let accountId: number;

async function form(contents: string) {
  const FormData = (await import('form-data')).default;
  const f = new FormData();
  f.append('file', Buffer.from(contents), { filename: 'releve.csv', contentType: 'text/csv' });
  return { headers: f.getHeaders(), payload: f.getBuffer() };
}

async function importCsv(contents: string) {
  const { headers, payload } = await form(contents);
  return app.inject({ method: 'POST', url: `/api/imports?accountId=${accountId}`, headers: { cookie, ...headers }, payload });
}

async function rowsOnAccount() {
  const { db } = await import('../src/db/client.js');
  const { transactions } = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  return db.select().from(transactions).where(eq(transactions.accountId, accountId));
}

describe.skipIf(!RUN)('dedup of repeated identical rows', () => {
  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    const { seedUserAndCookie, seedAccount } = await import('./helpers/seedUserAndCookie.js');
    app = await buildApp();
    ({ cookie, uid } = await seedUserAndCookie(app));
    accountId = await seedAccount(uid);
  });

  afterEach(async () => {
    const { db } = await import('../src/db/client.js');
    const { fileImports, transactions } = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.delete(transactions).where(eq(transactions.accountId, accountId));
    await db.delete(fileImports).where(eq(fileImports.accountId, accountId));
  });

  it('imports both identical same-day rows, and a re-import adds nothing', async () => {
    const first = await importCsv(TWO_COFFEES);
    expect(first.statusCode).toBe(201);
    expect(first.json().insertedCount).toBe(3);
    const rows = await rowsOnAccount();
    expect(rows.filter((r) => r.rawLabel === 'CAFE DU COIN')).toHaveLength(2);
    expect(rows.every((r) => r.dedupKey.startsWith('hash2:'))).toBe(true);

    const again = await importCsv(TWO_COFFEES);
    expect(again.statusCode).toBe(201);
    expect(again.json().insertedCount).toBe(0);
    expect(await rowsOnAccount()).toHaveLength(3);
  });

  it('a later file with a third identical row only adds the third', async () => {
    await importCsv(TWO_COFFEES);
    const three = TWO_COFFEES + '15/06/2026;CAFE DU COIN;-2,50\n';
    const res = await importCsv(three);
    expect(res.json().insertedCount).toBe(1);
    expect((await rowsOnAccount()).filter((r) => r.rawLabel === 'CAFE DU COIN')).toHaveLength(3);
  });

  it('preview flags one coffee as known and the second as new', async () => {
    await importCsv('Date;Libellé;Montant\n15/06/2026;CAFE DU COIN;-2,50\n');
    const { headers, payload } = await form(TWO_COFFEES);
    const res = await app.inject({
      method: 'POST', url: `/api/imports/preview?accountId=${accountId}`, headers: { cookie, ...headers }, payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().duplicateRows).toHaveLength(1);
    expect(res.json().newRows).toHaveLength(2);
  });

  it('manual entry: 409 duplicate_transaction, then force adds a distinct row', async () => {
    const body = { accountId, date: '2026-06-15', amount: '-2.50', rawLabel: 'CAFE DU COIN' };
    const one = await app.inject({ method: 'POST', url: '/api/transactions', headers: { cookie }, payload: body });
    expect(one.statusCode).toBe(201);

    const dup = await app.inject({ method: 'POST', url: '/api/transactions', headers: { cookie }, payload: body });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('duplicate_transaction');

    const forced = await app.inject({
      method: 'POST', url: '/api/transactions', headers: { cookie }, payload: { ...body, force: true },
    });
    expect(forced.statusCode).toBe(201);
    expect(forced.json().transaction.dedupKey).not.toBe(one.json().transaction.dedupKey);

    // The bank file listing both coffees now finds both: nothing new.
    const res = await importCsv(TWO_COFFEES);
    expect(res.json().insertedCount).toBe(1); // only the BOULANGERIE row
  });

  it('migration 0050 maps a legacy hash: key exactly like upgradeLegacyDedupKey', async () => {
    const { createHash } = await import('node:crypto');
    const { readFile } = await import('node:fs/promises');
    const { db } = await import('../src/db/client.js');
    const { transactions } = await import('../src/db/schema.js');
    const { sql, eq } = await import('drizzle-orm');
    const { upgradeLegacyDedupKey, computeDedupKey } = await import('../src/domain/imports/dedup.js');

    const legacy = 'hash:' + createHash('sha1').update(`${accountId}|2026-06-15|-2.50|cafe du coin`).digest('hex');
    const [row] = await db.insert(transactions).values({
      userId: uid, accountId, date: '2026-06-15', amount: '-2.50',
      rawLabel: 'CAFE DU COIN', normalizedLabel: 'cafe du coin', dedupKey: legacy,
    }).returning();

    const migration = await readFile(new URL('../src/db/migrations/0050_dedup_key_occurrence.sql', import.meta.url), 'utf8');
    await db.execute(sql.raw(migration));

    const [after] = await db.select().from(transactions).where(eq(transactions.id, row!.id));
    expect(after!.dedupKey).toBe(upgradeLegacyDedupKey(legacy));
    expect(after!.dedupKey).toBe(computeDedupKey({
      accountId, date: '2026-06-15', amount: '-2.50', normalizedLabel: 'cafe du coin',
    }));
  });
});
