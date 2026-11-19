// requires Postgres (or DB_DRIVER=pglite) — run with RUN_DB_TESTS=1
//
// Cross-tenant isolation: user B must not be able to write into, probe, or
// shift the balance of user A's accounts through imports, filename
// patterns or transaction edits, nor attach A's categories to B's rows.
// A foreign id must answer exactly like a missing one.
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN = !!process.env.RUN_DB_TESTS;

let app: FastifyInstance;
let cookieA: string;
let cookieB: string;
let uidA: number;
let uidB: number;
let accountA: number;
let accountB: number;
let categoryA: number;

async function buildForm(filename: string, contents: string | Buffer, contentType: string) {
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  const buf = typeof contents === 'string' ? Buffer.from(contents) : contents;
  form.append('file', buf, { filename, contentType });
  return { headers: form.getHeaders(), payload: form.getBuffer() };
}

async function countRows(accountId: number): Promise<{ tx: number; imports: number }> {
  const { db } = await import('../src/db/client.js');
  const { fileImports, transactions } = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const tx = await db.select({ id: transactions.id }).from(transactions)
    .where(eq(transactions.accountId, accountId));
  const imports = await db.select({ id: fileImports.id }).from(fileImports)
    .where(eq(fileImports.accountId, accountId));
  return { tx: tx.length, imports: imports.length };
}

async function insertTx(userId: number, accountId: number, amount: string, label: string) {
  const { db } = await import('../src/db/client.js');
  const { transactions } = await import('../src/db/schema.js');
  const [row] = await db.insert(transactions).values({
    userId, accountId, date: '2025-02-01', amount,
    rawLabel: label, normalizedLabel: label.toLowerCase(),
    dedupKey: `xt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  }).returning();
  return row!.id;
}

describe.skipIf(!RUN)('cross-tenant isolation', () => {
  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    const { seedUserAndCookie, seedAccount } = await import('./helpers/seedUserAndCookie.js');
    app = await buildApp();
    const a = await seedUserAndCookie(app);
    const b = await seedUserAndCookie(app);
    uidA = a.uid;
    uidB = b.uid;
    cookieA = a.cookie;
    cookieB = b.cookie;
    accountA = await seedAccount(uidA, { openingBalance: '100.00' });
    accountB = await seedAccount(uidB);

    const cat = await app.inject({
      method: 'POST', url: '/api/categories',
      headers: { cookie: cookieA }, payload: { name: 'A-only', kind: 'expense' },
    });
    categoryA = cat.json().category.id;
  });

  describe('imports', () => {
    it('POST /api/imports refuses another user\'s accountId like a missing one', async () => {
      const before = await countRows(accountA);
      for (const id of [accountA, 999_999]) {
        const { headers, payload } = await buildForm('x.csv', 'Date;Libellé;Montant\n01/02/2025;CAFE;-2,50\n', 'text/csv');
        const res = await app.inject({
          method: 'POST', url: `/api/imports?accountId=${id}`,
          headers: { cookie: cookieB, ...headers }, payload,
        });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ error: 'account_not_found' });
      }
      expect(await countRows(accountA)).toEqual(before);
    });

    it('POST /api/imports/preview refuses another user\'s accountId', async () => {
      const { headers, payload } = await buildForm('x.csv', 'Date;Libellé;Montant\n01/02/2025;CAFE;-2,50\n', 'text/csv');
      const res = await app.inject({
        method: 'POST', url: `/api/imports/preview?accountId=${accountA}`,
        headers: { cookie: cookieB, ...headers }, payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'account_not_found' });
    });

    it('POST /api/imports/photo refuses another user\'s accountId', async () => {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
      const { headers, payload } = await buildForm('a.jpg', jpeg, 'image/jpeg');
      const res = await app.inject({
        method: 'POST', url: `/api/imports/photo?accountId=${accountA}`,
        headers: { cookie: cookieB, ...headers }, payload,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'account_not_found' });
    });

    it('runImport refuses a foreign account even when called directly', async () => {
      const { runImport } = await import('../src/domain/imports/import-service.js');
      const before = await countRows(accountA);
      await expect(runImport({
        filename: 'x.csv', accountId: accountA, userId: uidB, format: 'csv',
        buffer: Buffer.from('Date;Libellé;Montant\n01/02/2025;CAFE;-2,50\n'),
      })).rejects.toMatchObject({ code: 'account_not_found' });
      expect(await countRows(accountA)).toEqual(before);
    });

    it('a filename pattern pointing at a foreign account never resolves', async () => {
      // A row created before the route checked ownership.
      const { db } = await import('../src/db/client.js');
      const { accountFilenamePatterns } = await import('../src/db/schema.js');
      await db.insert(accountFilenamePatterns).values({
        userId: uidB, accountId: accountA, pattern: 'legacy-foreign', priority: 0,
      });
      const { headers, payload } = await buildForm('legacy-foreign.csv', 'Date;Libellé;Montant\n', 'text/csv');
      const res = await app.inject({
        method: 'POST', url: '/api/imports',
        headers: { cookie: cookieB, ...headers }, payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/cannot determine target account/);
    });
  });

  describe('filename patterns', () => {
    it('POST refuses another user\'s accountId', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/account-filename-patterns',
        headers: { cookie: cookieB }, payload: { pattern: 'steal', accountId: accountA },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unknown accountId' });
    });

    it('PUT refuses to repoint a pattern at another user\'s account', async () => {
      const created = await app.inject({
        method: 'POST', url: '/api/account-filename-patterns',
        headers: { cookie: cookieB }, payload: { pattern: 'mine', accountId: accountB },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().pattern.id;
      const res = await app.inject({
        method: 'PUT', url: `/api/account-filename-patterns/${id}`,
        headers: { cookie: cookieB }, payload: { accountId: accountA },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unknown accountId' });

      const ok = await app.inject({
        method: 'PUT', url: `/api/account-filename-patterns/${id}`,
        headers: { cookie: cookieB }, payload: { priority: 5 },
      });
      expect(ok.statusCode).toBe(200);
    });
  });

  describe('transactions', () => {
    it('PATCH refuses to move a row into another user\'s account', async () => {
      const txId = await insertTx(uidB, accountB, '-500.00', 'MOVE ME');
      const res = await app.inject({
        method: 'PATCH', url: `/api/transactions/${txId}`,
        headers: { cookie: cookieB }, payload: { accountId: accountA },
      });
      expect(res.statusCode).toBe(400);
      expect(await countRows(accountA)).toMatchObject({ tx: 0 });

      const { seedAccount } = await import('./helpers/seedUserAndCookie.js');
      const ownTarget = await seedAccount(uidB);
      const ok = await app.inject({
        method: 'PATCH', url: `/api/transactions/${txId}`,
        headers: { cookie: cookieB }, payload: { accountId: ownTarget },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().transaction.accountId).toBe(ownTarget);
    });

    it('account balances ignore rows owned by another user', async () => {
      // A row that reached A's account before the PATCH guard existed.
      const strayId = await insertTx(uidB, accountA, '-40.00', 'STRAY');
      try {
        const res = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: cookieA } });
        expect(res.statusCode).toBe(200);
        const acc = (res.json().accounts as Array<{ id: number; currentBalance: string; transactionCount: number }>)
          .find((r) => r.id === accountA)!;
        expect(Number(acc.currentBalance)).toBe(100);
        expect(acc.transactionCount).toBe(0);
      } finally {
        const { db } = await import('../src/db/client.js');
        const { transactions } = await import('../src/db/schema.js');
        const { eq } = await import('drizzle-orm');
        await db.delete(transactions).where(eq(transactions.id, strayId));
      }
    });

    it('POST refuses another user\'s categoryId', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/transactions',
        headers: { cookie: cookieB },
        payload: { accountId: accountB, date: '2025-03-01', amount: '-1.00', rawLabel: 'X', categoryId: categoryA },
      });
      expect(res.statusCode).toBe(400);
    });

    it('PATCH refuses another user\'s categoryId', async () => {
      const txId = await insertTx(uidB, accountB, '-3.00', 'CAT PATCH');
      const res = await app.inject({
        method: 'PATCH', url: `/api/transactions/${txId}`,
        headers: { cookie: cookieB }, payload: { categoryId: categoryA },
      });
      expect(res.statusCode).toBe(400);
    });

    it('categorize-bulk refuses another user\'s categoryId', async () => {
      const txId = await insertTx(uidB, accountB, '-4.00', 'CAT BULK');
      const res = await app.inject({
        method: 'POST', url: '/api/transactions/categorize-bulk',
        headers: { cookie: cookieB }, payload: { ids: [txId], categoryId: categoryA },
      });
      expect(res.statusCode).toBe(400);
      const { db } = await import('../src/db/client.js');
      const { transactions } = await import('../src/db/schema.js');
      const { eq } = await import('drizzle-orm');
      const [row] = await db.select().from(transactions).where(eq(transactions.id, txId));
      expect(row!.categoryId).toBeNull();
    });
  });
});

