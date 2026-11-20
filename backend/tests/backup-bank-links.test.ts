// requires Postgres + onboarding setup — run with RUN_DB_TESTS=1
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN = !!process.env.RUN_DB_TESTS;
const PASS = 'bank-links-1234';
const EXPORT_PASS = 'test-passphrase-1';

let app: FastifyInstance;

type Session = { cookie: string; uid: number };

async function onboard(username: string): Promise<Session> {
  await app.inject({
    method: 'POST', url: '/api/onboarding/create',
    payload: { username, password: PASS },
  });
  const login = await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { username, password: PASS },
  });
  expect(login.statusCode).toBe(200);
  return {
    cookie: login.cookies[0]!.name + '=' + login.cookies[0]!.value,
    uid: login.json().user.id as number,
  };
}

async function createAccount(s: Session, name: string): Promise<number> {
  const res = await app.inject({
    method: 'POST', url: '/api/accounts',
    headers: { cookie: s.cookie },
    payload: { name, type: 'checking', currency: 'EUR', openingBalance: '0', openingDate: '2025-01-01' },
  });
  expect(res.statusCode).toBeLessThan(300);
  return res.json().account.id as number;
}

async function createLink(
  s: Session,
  accountId: number | null,
  uid: string,
): Promise<{ connectionId: number; bcaId: number }> {
  const { db } = await import('../src/db/client.js');
  const { bankConnections, bankConnectionAccounts } = await import('../src/db/schema.js');
  const [conn] = await db.insert(bankConnections).values({
    userId: s.uid,
    sessionId: `sess-${s.uid}-${uid}`,
    aspspName: 'TestBank',
    aspspCountry: 'FR',
    validUntil: '2030-01-01',
  }).returning();
  const [bca] = await db.insert(bankConnectionAccounts).values({
    connectionId: conn!.id,
    bankAccountUid: uid,
    iban: `FR76${uid}`,
    name: `bank-${uid}`,
    currency: 'EUR',
    accountId,
    lastSyncedAt: new Date('2026-01-02T03:04:05Z'),
  }).returning();
  return { connectionId: conn!.id, bcaId: bca!.id };
}

async function readLinks(connectionId: number) {
  const { db } = await import('../src/db/client.js');
  const { bankConnectionAccounts } = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  return db.select().from(bankConnectionAccounts)
    .where(eq(bankConnectionAccounts.connectionId, connectionId));
}

async function exportDump(s: Session) {
  const { decryptEnvelope } = await import('../src/http/routes/backup/crypto.js');
  const res = await app.inject({
    method: 'POST', url: '/api/backup/export',
    headers: { cookie: s.cookie }, payload: { passphrase: EXPORT_PASS },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(decryptEnvelope(res.json(), EXPORT_PASS));
}

async function importDump(s: Session, dump: unknown) {
  return app.inject({
    method: 'POST', url: '/api/backup/import',
    headers: { cookie: s.cookie }, payload: dump as object,
  });
}

// Removes every user not in `keep` so the test controls which wipe path
// (TRUNCATE for a sole user, per-user DELETEs otherwise) the restore takes.
// Files run serially and other files already do global wipes.
async function onlyUsers(...keep: number[]) {
  const { db } = await import('../src/db/client.js');
  const { users } = await import('../src/db/schema.js');
  const { notInArray } = await import('drizzle-orm');
  await db.delete(users).where(notInArray(users.id, keep));
}

describe.skipIf(!RUN)('backup restore keeps bank account links', () => {
  let a: Session;

  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    app = await buildApp();
  });

  beforeEach(async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    a = await onboard(`bank-links-a-${stamp}`);
  });

  it('single user (TRUNCATE path): re-links by account name and keeps the row', async () => {
    await onlyUsers(a.uid);
    const checking = await createAccount(a, 'Checking');
    const { connectionId, bcaId } = await createLink(a, checking, '0001');
    const dump = await exportDump(a);

    const res = await importDump(a, dump);
    expect(res.statusCode).toBe(200);
    expect(res.json().unlinkedBankAccounts).toEqual([]);

    const accs = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: a.cookie } });
    const newChecking = accs.json().accounts.find((x: { name: string }) => x.name === 'Checking');
    expect(newChecking.id).not.toBe(checking);

    const links = await readLinks(connectionId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      id: bcaId,
      bankAccountUid: '0001',
      iban: 'FR760001',
      name: 'bank-0001',
      currency: 'EUR',
      accountId: newChecking.id,
    });
    expect(links[0]!.lastSyncedAt?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
  });

  it('a link whose account name is absent from the dump ends up NULL and is reported', async () => {
    await onlyUsers(a.uid);
    const checking = await createAccount(a, 'Checking');
    const savings = await createAccount(a, 'Savings');
    const l1 = await createLink(a, checking, '0001');
    const l2 = await createLink(a, savings, '0002');
    const dump = await exportDump(a);
    dump.accounts = dump.accounts.filter((x: { name: string }) => x.name !== 'Savings');

    const res = await importDump(a, dump);
    expect(res.statusCode).toBe(200);
    expect(res.json().unlinkedBankAccounts).toEqual([
      {
        connectionId: l2.connectionId,
        bankAccountUid: '0002',
        bankAccountName: 'bank-0002',
        iban: 'FR760002',
        previousAccountName: 'Savings',
      },
    ]);

    const [kept] = await readLinks(l1.connectionId);
    expect(kept!.accountId).not.toBeNull();
    const [orphan] = await readLinks(l2.connectionId);
    expect(orphan).toBeTruthy();
    expect(orphan!.accountId).toBeNull();
  });

  it('multi-user (DELETE path): re-links by name and leaves the other user untouched', async () => {
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const b = await onboard(`bank-links-b-${stamp}`);
    await onlyUsers(a.uid, b.uid);
    const checkingA = await createAccount(a, 'Checking');
    const checkingB = await createAccount(b, 'Checking');
    const la = await createLink(a, checkingA, '0001');
    const lb = await createLink(b, checkingB, '0002');
    const dump = await exportDump(a);

    const res = await importDump(a, dump);
    expect(res.statusCode).toBe(200);
    expect(res.json().unlinkedBankAccounts).toEqual([]);

    const accs = await app.inject({ method: 'GET', url: '/api/accounts', headers: { cookie: a.cookie } });
    const newChecking = accs.json().accounts.find((x: { name: string }) => x.name === 'Checking');
    const [linkA] = await readLinks(la.connectionId);
    expect(linkA!.id).toBe(la.bcaId);
    expect(linkA!.accountId).toBe(newChecking.id);

    const [linkB] = await readLinks(lb.connectionId);
    expect(linkB!.id).toBe(lb.bcaId);
    expect(linkB!.accountId).toBe(checkingB);
  });
});
