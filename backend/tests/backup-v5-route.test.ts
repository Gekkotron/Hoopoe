// requires a database — locally: DB_DRIVER=pglite RUN_DB_TESTS=1
// Backup format v5: envelopes, recurring series, PDF templates, FX rates and
// settings round-trip through the portable dump.
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

const RUN = !!process.env.RUN_DB_TESTS;
const PASS = 'test-passphrase-1';
const WEBHOOK = 'https://discord.com/api/webhooks/123456/secret-token-abc';
const API_KEY = 'callmebot-key-777';

let app: FastifyInstance;
let cookie: string;
let uid: number;

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function exportDump() {
  const { decryptEnvelope } = await import('../src/http/routes/backup/crypto.js');
  const res = await call('POST', '/api/backup/export', { passphrase: PASS });
  expect(res.statusCode).toBe(200);
  return JSON.parse(decryptEnvelope(res.json(), PASS));
}

async function importDump(dump: unknown) {
  const res = await call('POST', '/api/backup/import', dump);
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function rawSettings(): Promise<Record<string, any>> {
  const { db } = await import('../src/db/client.js');
  const { userSettings } = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, uid));
  return (row?.settings ?? {}) as Record<string, any>;
}

async function accountIdByName(name: string): Promise<number> {
  const res = await call('GET', '/api/accounts');
  return res.json().accounts.find((a: { name: string }) => a.name === name).id;
}

async function categoryIdByName(name: string): Promise<number> {
  const res = await call('GET', '/api/categories');
  return res.json().categories.find((c: { name: string }) => c.name === name).id;
}

async function readAll() {
  const { db } = await import('../src/db/client.js');
  const s = await import('../src/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [assignments, cats, holds, series, links, templates, fx] = await Promise.all([
    db.select().from(s.envelopeAssignments).where(eq(s.envelopeAssignments.userId, uid)),
    db.select().from(s.envelopeCategorySettings).where(eq(s.envelopeCategorySettings.userId, uid)),
    db.select().from(s.envelopeMonthHolds).where(eq(s.envelopeMonthHolds.userId, uid)),
    db.select().from(s.recurringSeries).where(eq(s.recurringSeries.userId, uid)),
    db.select({ seriesId: s.recurringSeriesTransactions.seriesId, date: s.transactions.date, id: s.transactions.id })
      .from(s.recurringSeriesTransactions)
      .innerJoin(s.transactions, eq(s.transactions.id, s.recurringSeriesTransactions.transactionId))
      .where(eq(s.transactions.userId, uid)),
    db.select().from(s.pdfStatementTemplates).where(eq(s.pdfStatementTemplates.userId, uid)),
    db.select().from(s.fxRates).where(eq(s.fxRates.userId, uid)),
  ]);
  return { assignments, cats, holds, series, links, templates, fx };
}

describe.skipIf(!RUN)('backup format v5', () => {
  beforeAll(async () => {
    const { buildApp } = await import('./helpers/build-app.js');
    app = await buildApp();
    const creds = { username: 'backup-v5', password: 'backup-v5-1234' };
    await app.inject({ method: 'POST', url: '/api/onboarding/create', payload: creds });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds });
    const c = res.cookies[0]!;
    cookie = `${c.name}=${c.value}`;
    uid = (await call('GET', '/api/auth/me')).json().user.id;
  });

  async function seed() {
    const acc = await call('POST', '/api/accounts', {
      name: 'V5 Checking', type: 'checking', currency: 'EUR', openingBalance: '100', openingDate: '2025-01-01',
    });
    const accId = acc.json().account.id as number;
    const parent = await call('POST', '/api/categories', { name: 'V5 Parent', kind: 'expense' });
    const parentId = parent.json().category.id as number;
    const child = await call('POST', '/api/categories', { name: 'V5 Groceries', kind: 'expense', parentId });
    const catId = child.json().category.id as number;

    // Three transactions so the recurring link indices are not trivially 0.
    for (const date of ['2026-03-05', '2026-04-05', '2026-05-05']) {
      const r = await call('POST', '/api/transactions', {
        accountId: accId, date, amount: '-12.99', rawLabel: 'NETFLIX',
      });
      expect(r.statusCode).toBeLessThan(300);
    }

    expect((await call('PUT', '/api/envelopes/assignments', {
      categoryId: catId, month: '2026-05', amount: '250.00', currency: 'EUR',
    })).statusCode).toBe(201);
    expect((await call('PUT', `/api/envelopes/categories/${catId}`, {
      targetAmount: '1000.00', targetDate: '2026-12-01', targetKind: 'save_by_date', overspendPolicy: 'reallocate_manual',
    })).statusCode).toBe(200);
    expect((await call('PUT', '/api/envelopes/holds', { month: '2026-05', amount: '40.00' })).statusCode).toBe(200);

    expect((await call('POST', '/api/fx-rates', {
      from: 'USD', to: 'EUR', effectiveFrom: '2026-01-01', rate: '0.92',
    })).statusCode).toBeLessThan(300);

    const patch = await call('PATCH', '/api/settings', {
      displayCurrency: 'EUR',
      showForecast: false,
      transactionsDefaultAccount: accId,
      notifications: {
        enabled: true,
        privacy: { hideAmount: true },
        channels: {
          discord: { enabled: true, webhookUrl: WEBHOOK, maxPerMinute: 7 },
          callmebot: { enabled: true, phone: '+33600000000', apiKey: API_KEY },
        },
        triggers: {
          bigTransaction: { enabled: true, thresholds: { [String(accId)]: 500 } },
          accountLow: { enabled: true, floors: { [String(accId)]: 50 } },
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    // Recurring series and PDF templates have no create route: seed via db.
    const { db } = await import('../src/db/client.js');
    const { recurringSeries, recurringSeriesTransactions, transactions, pdfStatementTemplates } = await import('../src/db/schema.js');
    const { eq, and } = await import('drizzle-orm');
    const [series] = await db.insert(recurringSeries).values({
      userId: uid, label: 'netflix', cadenceDays: 30, avgAmount: '-12.99', amountStddev: '0.00',
      categoryId: catId, firstSeenAt: '2026-03-05', lastSeenAt: '2026-05-05', nextDueAt: '2026-06-05',
      status: 'confirmed', essentialness: 'discretionary',
    }).returning();
    const apr = await db.select().from(transactions)
      .where(and(eq(transactions.userId, uid), eq(transactions.date, '2026-04-05')));
    const may = await db.select().from(transactions)
      .where(and(eq(transactions.userId, uid), eq(transactions.date, '2026-05-05')));
    await db.insert(recurringSeriesTransactions).values([
      { seriesId: series!.id, transactionId: apr[0]!.id },
      { seriesId: series!.id, transactionId: may[0]!.id },
    ]);
    await db.insert(pdfStatementTemplates).values([
      { userId: uid, fingerprint: 'fp-account', accountId: accId, label: 'Bank layout', zones: { pageAnchor: 'RELEVE' }, source: 'interactive' },
      { userId: uid, fingerprint: 'fp-global', accountId: null, label: 'Generic layout', zones: { pageAnchor: 'X' }, source: 'interactive' },
    ]);
  }

  it('round-trips every new area with refs intact and keeps notification secrets out of the dump', async () => {
    await seed();
    const dump = await exportDump();

    expect(dump.version).toBe(5);
    expect(dump.counts).toMatchObject({
      envelopeAssignments: 1, envelopeCategorySettings: 1, envelopeMonthHolds: 1,
      recurringSeries: 1, pdfStatementTemplates: 2, fxRates: 1,
    });
    expect(dump.envelopeAssignments[0]).toEqual({
      category: 'V5 Groceries', categoryParent: 'V5 Parent', month: '2026-05-01', amount: '250.00', currency: 'EUR',
    });
    expect(dump.recurringSeries[0].category).toBe('V5 Groceries');
    expect(dump.pdfStatementTemplates.map((t: { account: string | null }) => t.account).sort())
      .toEqual(['V5 Checking', null]);

    // No secret of any kind in the serialized dump.
    const text = JSON.stringify(dump);
    for (const secret of [WEBHOOK, API_KEY, 'webhookUrl', 'apiKey', 'mcpKeyWrapped']) {
      expect(text).not.toContain(secret);
    }
    // Notification preferences survive.
    expect(dump.userSettings.settings.notifications.privacy.hideAmount).toBe(true);
    expect(dump.userSettings.settings.notifications.channels.discord.maxPerMinute).toBe(7);

    const before = await rawSettings();
    expect(before.notifications.channels.discord.webhookUrlEnc).toBeTruthy();
    expect(before.notifications.channels.callmebot.apiKeyEnc).toBeTruthy();

    // Simulate a machine move: new target with its own discord secret, no callmebot key,
    // no fx rates and no holds.
    const { db } = await import('../src/db/client.js');
    const s = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.delete(s.fxRates).where(eq(s.fxRates.userId, uid));
    await db.delete(s.envelopeMonthHolds).where(eq(s.envelopeMonthHolds.userId, uid));
    await db.delete(s.userSettings).where(eq(s.userSettings.userId, uid));
    // Columns the dump never carries must survive too (MCP key, dismissed tips).
    await db.insert(s.userSettings).values({
      userId: uid, mcpEnabled: true, mcpKeyWrapped: 'wrapped-key', mcpReadOnly: false, dismissedTips: { a: 'b' },
    });
    await call('PATCH', '/api/settings', {
      notifications: { channels: { discord: { webhookUrl: 'https://discord.com/api/webhooks/999/other-target-token' } } },
    });
    const targetEnc = (await rawSettings()).notifications.channels.discord.webhookUrlEnc;
    expect(targetEnc).toBeTruthy();

    const res = await importDump(dump);
    expect(res.imported).toMatchObject({
      envelopeAssignments: 1, envelopeCategorySettings: 1, envelopeMonthHolds: 1,
      recurringSeries: 1, pdfStatementTemplates: 2, fxRates: 1,
    });

    const after = await readAll();
    const accId = await accountIdByName('V5 Checking');
    const catId = await categoryIdByName('V5 Groceries');
    expect(after.assignments).toHaveLength(1);
    expect(after.assignments[0]).toMatchObject({ categoryId: catId, month: '2026-05-01', amount: '250.00' });
    expect(after.cats[0]).toMatchObject({
      categoryId: catId, targetAmount: '1000.00', targetDate: '2026-12-01',
      targetKind: 'save_by_date', overspendPolicy: 'reallocate_manual',
    });
    expect(after.holds[0]).toMatchObject({ month: '2026-05-01', amount: '40.00' });
    expect(after.fx[0]).toMatchObject({ fromCcy: 'USD', toCcy: 'EUR', effectiveFrom: '2026-01-01' });
    expect(Number(after.fx[0]!.rate)).toBeCloseTo(0.92);
    expect(after.series).toHaveLength(1);
    expect(after.series[0]).toMatchObject({
      label: 'netflix', cadenceDays: 30, categoryId: catId, status: 'confirmed', essentialness: 'discretionary',
    });
    const tplByLabel = new Map(after.templates.map((t) => [t.label, t]));
    expect(tplByLabel.get('Bank layout')!.accountId).toBe(accId);
    expect(tplByLabel.get('Generic layout')!.accountId).toBeNull();
    expect(tplByLabel.get('Bank layout')!.zones).toEqual({ pageAnchor: 'RELEVE' });

    // The series links point at the April and May transactions, not at the March one.
    expect(after.links.map((l) => l.date).sort()).toEqual(['2026-04-05', '2026-05-05']);
    expect(after.links.every((l) => l.seriesId === after.series[0]!.id)).toBe(true);

    // Settings: preferences restored, account-id keyed fields remapped to the new
    // account id, and the target's own secret survived (the dump carried none).
    const restored = await rawSettings();
    expect(restored.showForecast).toBe(false);
    expect(restored.notifications.privacy.hideAmount).toBe(true);
    expect(restored.transactionsDefaultAccount).toBe(accId);
    expect(restored.notifications.triggers.bigTransaction.thresholds).toEqual({ [String(accId)]: 500 });
    expect(restored.notifications.triggers.accountLow.floors).toEqual({ [String(accId)]: 50 });
    expect(restored.notifications.channels.discord.webhookUrlEnc).toBe(targetEnc);
    expect(restored.notifications.channels.callmebot.apiKeyEnc).toBeUndefined();
    const [row] = await db.select().from(s.userSettings).where(eq(s.userSettings.userId, uid));
    expect(row).toMatchObject({
      mcpEnabled: true, mcpKeyWrapped: 'wrapped-key', mcpReadOnly: false, dismissedTips: { a: 'b' },
    });
  });

  it('keeps the target secrets even when the dump itself smuggles some in', async () => {
    const enc = (await rawSettings()).notifications.channels.discord.webhookUrlEnc;
    const dump = await exportDump();
    dump.userSettings.settings.notifications.channels.discord.webhookUrl = 'https://discord.com/api/webhooks/1/evil';
    dump.userSettings.settings.notifications.channels.discord.webhookUrlEnc = 'attacker-ciphertext';
    await importDump(dump);
    const after = await rawSettings();
    expect(after.notifications.channels.discord.webhookUrlEnc).toBe(enc);
    expect(after.notifications.channels.discord.webhookUrl).toBeUndefined();
  });

  it('skips rows whose category or account ref is unknown and counts them', async () => {
    const dump = await exportDump();
    dump.envelopeAssignments.push({ category: 'Ghost', categoryParent: null, month: '2026-06-01', amount: '1.00', currency: 'EUR' });
    dump.envelopeCategorySettings.push({
      category: 'Ghost', categoryParent: null, targetAmount: null, targetDate: null, targetKind: null, overspendPolicy: 'rollover_negative',
    });
    dump.pdfStatementTemplates.push({ fingerprint: 'fp-ghost', account: 'Ghost account', label: 'Ghost', zones: {}, source: 'interactive' });
    dump.recurringSeries.push({
      label: 'ghost', cadenceDays: 7, avgAmount: '-1.00', amountStddev: '0.00', category: 'Ghost', categoryParent: null,
      firstSeenAt: '2026-01-01', lastSeenAt: '2026-01-08', nextDueAt: '2026-01-15', status: 'detected', essentialness: null,
      transactions: [],
    });
    // A link to a transaction index that does not exist is dropped; the series is kept.
    dump.recurringSeries[0].transactions.push(9999);

    const res = await importDump(dump);
    expect(res.skipped).toMatchObject({
      envelopeAssignments: 1, envelopeCategorySettings: 1, pdfStatementTemplates: 1, recurringSeries: 1,
      recurringSeriesTransactions: 1,
    });
    expect(res.imported.envelopeAssignments).toBe(1);
    expect(res.imported.recurringSeries).toBe(1);
  });

  it('a v4 dump leaves user_settings, fx_rates and month holds untouched and wipes the rest', async () => {
    const dump = await exportDump();
    for (const k of [
      'envelopeAssignments', 'envelopeCategorySettings', 'envelopeMonthHolds', 'recurringSeries',
      'pdfStatementTemplates', 'fxRates', 'userSettings',
    ]) delete dump[k];
    dump.version = 4;

    const settingsBefore = await rawSettings();
    await importDump(dump);

    const after = await readAll();
    expect(after.fx).toHaveLength(1);
    expect(after.holds).toHaveLength(1);
    expect(await rawSettings()).toEqual(settingsBefore);
    // Tables hanging off categories/accounts cannot be preserved by an older dump.
    expect(after.assignments).toEqual([]);
    expect(after.cats).toEqual([]);
    expect(after.series).toEqual([]);
    expect(after.templates.filter((t) => t.accountId !== null)).toEqual([]);
  });

  it('behaves the same on the multi-user path and leaves other users alone', async () => {
    const other = { username: 'backup-v5-other', password: 'backup-v5-other-1234' };
    await app.inject({ method: 'POST', url: '/api/onboarding/create', payload: other });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: other });
    expect(login.statusCode).toBe(200);
    const otherUid = login.json().user.id as number;
    const { db } = await import('../src/db/client.js');
    const s = await import('../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.insert(s.fxRates).values({ userId: otherUid, fromCcy: 'GBP', toCcy: 'EUR', effectiveFrom: '2026-01-01', rate: '1.1' });
    await db.insert(s.envelopeMonthHolds).values({ userId: otherUid, month: '2026-02-01', amount: '9.00' });

    // Restore a v5 dump that carries different fx rates and holds.
    const dump = await exportDump();
    dump.fxRates = [{ from: 'CHF', to: 'EUR', effectiveFrom: '2026-02-01', rate: '1.05' }];
    dump.envelopeMonthHolds = [{ month: '2026-07-01', amount: '5.00' }];
    await importDump(dump);
    const mine = await readAll();
    expect(mine.fx.map((r) => r.fromCcy)).toEqual(['CHF']);
    expect(mine.holds.map((h) => h.month)).toEqual(['2026-07-01']);
    expect(mine.series).toHaveLength(dump.recurringSeries.length);
    expect(mine.templates).toHaveLength(dump.pdfStatementTemplates.length);

    // The other user's rows are untouched.
    expect(await db.select().from(s.fxRates).where(eq(s.fxRates.userId, otherUid))).toHaveLength(1);
    expect(await db.select().from(s.envelopeMonthHolds).where(eq(s.envelopeMonthHolds.userId, otherUid))).toHaveLength(1);

    // A v4 dump on this path also leaves them (and the caller's own) alone.
    for (const k of ['fxRates', 'envelopeMonthHolds', 'userSettings', 'recurringSeries', 'pdfStatementTemplates']) delete dump[k];
    const settingsBefore = await rawSettings();
    await importDump(dump);
    expect((await readAll()).fx.map((r) => r.fromCcy)).toEqual(['CHF']);
    expect(await rawSettings()).toEqual(settingsBefore);
  });
});
