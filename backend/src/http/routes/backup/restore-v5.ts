import { db } from '../../../db/client.js';
import {
  envelopeAssignments,
  envelopeCategorySettings,
  envelopeMonthHolds,
  fxRates,
  pdfStatementTemplates,
  recurringSeries,
  recurringSeriesTransactions,
  userSettings,
} from '../../../db/schema.js';
import { fromDumpedSettings } from '../../../domain/backup/settings-dump.js';
import type { WipeSnapshot } from './wipe.js';
import { resolveCategoryRef, resolveNameToId } from './helpers.js';
import type { CategoryMaps } from './restore-steps.js';
import type { BackupDump } from './schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const CHUNK = 500;

// Restore steps for the v5 sections. Each returns what it inserted and what it
// skipped because a category/account ref did not resolve. Inserts use
// ON CONFLICT DO NOTHING and count what RETURNING gives back, so a
// hand-edited dump with duplicate natural keys is dropped rather than failing
// the whole restore transaction.

export async function restoreEnvelopes(
  tx: Tx,
  uid: number,
  assignments: NonNullable<BackupDump['envelopeAssignments']>,
  catSettings: NonNullable<BackupDump['envelopeCategorySettings']>,
  holds: NonNullable<BackupDump['envelopeMonthHolds']>,
  cats: CategoryMaps,
): Promise<{
  assignmentsInserted: number; assignmentsSkipped: number;
  settingsInserted: number; settingsSkipped: number;
  holdsInserted: number;
}> {
  const catId = (name: string, parent: string | null | undefined) =>
    resolveCategoryRef(name, parent ?? null, cats.categoryIdByPath, cats.categoryIdsByName);

  const asgRows: Array<typeof envelopeAssignments.$inferInsert> = [];
  let assignmentsSkipped = 0;
  for (const a of assignments) {
    const categoryId = catId(a.category, a.categoryParent);
    if (categoryId === null) { assignmentsSkipped++; continue; }
    asgRows.push({ userId: uid, categoryId, month: a.month, amount: a.amount, currency: a.currency });
  }
  let assignmentsInserted = 0;
  for (let i = 0; i < asgRows.length; i += CHUNK) {
    const r = await tx.insert(envelopeAssignments).values(asgRows.slice(i, i + CHUNK))
      .onConflictDoNothing().returning({ id: envelopeAssignments.id });
    assignmentsInserted += r.length;
  }

  const setRows: Array<typeof envelopeCategorySettings.$inferInsert> = [];
  let settingsSkipped = 0;
  for (const e of catSettings) {
    const categoryId = catId(e.category, e.categoryParent);
    if (categoryId === null) { settingsSkipped++; continue; }
    setRows.push({
      userId: uid, categoryId,
      targetAmount: e.targetAmount, targetDate: e.targetDate, targetKind: e.targetKind,
      overspendPolicy: e.overspendPolicy,
    });
  }
  let settingsInserted = 0;
  for (let i = 0; i < setRows.length; i += CHUNK) {
    const r = await tx.insert(envelopeCategorySettings).values(setRows.slice(i, i + CHUNK))
      .onConflictDoNothing().returning({ categoryId: envelopeCategorySettings.categoryId });
    settingsInserted += r.length;
  }

  let holdsInserted = 0;
  for (let i = 0; i < holds.length; i += CHUNK) {
    const r = await tx.insert(envelopeMonthHolds)
      .values(holds.slice(i, i + CHUNK).map((h) => ({ userId: uid, month: h.month, amount: h.amount })))
      .onConflictDoNothing().returning({ month: envelopeMonthHolds.month });
    holdsInserted += r.length;
  }
  return { assignmentsInserted, assignmentsSkipped, settingsInserted, settingsSkipped, holdsInserted };
}

// Recurring series. A series' member transactions arrive as indices into the
// dump's `transactions` array; `txIdByDumpIndex` (filled by restoreTransactions)
// maps them to the freshly inserted ids. An index with no entry (out of range,
// or the transaction was skipped) drops that link only.
export async function restoreRecurringSeries(
  tx: Tx,
  uid: number,
  series: NonNullable<BackupDump['recurringSeries']>,
  cats: CategoryMaps,
  txIdByDumpIndex: Map<number, number>,
): Promise<{ inserted: number; skipped: number; linksSkipped: number }> {
  let inserted = 0;
  let skipped = 0;
  let linksSkipped = 0;
  for (const s of series) {
    let categoryId: number | null = null;
    if (s.category !== null) {
      categoryId = resolveCategoryRef(s.category, s.categoryParent ?? null, cats.categoryIdByPath, cats.categoryIdsByName);
      if (categoryId === null) { skipped++; continue; }
    }
    const [row] = await tx.insert(recurringSeries).values({
      userId: uid,
      label: s.label,
      cadenceDays: s.cadenceDays,
      avgAmount: s.avgAmount,
      amountStddev: s.amountStddev,
      categoryId,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      nextDueAt: s.nextDueAt,
      status: s.status,
      essentialness: s.essentialness,
    }).onConflictDoNothing().returning({ id: recurringSeries.id });
    if (!row) { skipped++; continue; }
    inserted++;
    const links: Array<typeof recurringSeriesTransactions.$inferInsert> = [];
    for (const idx of s.transactions) {
      const transactionId = txIdByDumpIndex.get(idx);
      if (transactionId === undefined) { linksSkipped++; continue; }
      links.push({ seriesId: row.id, transactionId });
    }
    for (let i = 0; i < links.length; i += CHUNK) {
      await tx.insert(recurringSeriesTransactions).values(links.slice(i, i + CHUNK)).onConflictDoNothing();
    }
  }
  return { inserted, skipped, linksSkipped };
}

export async function restorePdfTemplates(
  tx: Tx,
  uid: number,
  templates: NonNullable<BackupDump['pdfStatementTemplates']>,
  accountIdByName: Map<string, number>,
): Promise<{ inserted: number; skipped: number }> {
  const rows: Array<typeof pdfStatementTemplates.$inferInsert> = [];
  let skipped = 0;
  for (const t of templates) {
    let accountId: number | null = null;
    if (t.account !== null) {
      accountId = resolveNameToId(t.account, accountIdByName);
      if (accountId === null) { skipped++; continue; }
    }
    rows.push({
      userId: uid, accountId, fingerprint: t.fingerprint, label: t.label, zones: t.zones, source: t.source,
    });
  }
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await tx.insert(pdfStatementTemplates).values(rows.slice(i, i + CHUNK))
      .onConflictDoNothing().returning({ id: pdfStatementTemplates.id });
    inserted += r.length;
  }
  return { inserted, skipped };
}

export async function restoreFxRates(
  tx: Tx,
  uid: number,
  rates: NonNullable<BackupDump['fxRates']>,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rates.length; i += CHUNK) {
    const r = await tx.insert(fxRates)
      .values(rates.slice(i, i + CHUNK).map((x) => ({
        userId: uid, fromCcy: x.from, toCcy: x.to, effectiveFrom: x.effectiveFrom, rate: x.rate,
      })))
      .onConflictDoNothing().returning({ id: fxRates.id });
    inserted += r.length;
  }
  return inserted;
}

// Upserts the settings JSON only. The row's other columns (MCP key and flags,
// dismissed tips) are never touched on an existing row; when the wipe emptied
// the table (single-user TRUNCATE path) they are re-inserted from the
// pre-wipe snapshot. The target's notification secrets are carried over by
// fromDumpedSettings, read from that same snapshot.
export async function restoreUserSettings(
  tx: Tx,
  uid: number,
  dumped: NonNullable<BackupDump['userSettings']>,
  snapshot: WipeSnapshot,
  accountIdByName: Map<string, number>,
): Promise<void> {
  const prior = snapshot.userSettingsRow;
  const settings = fromDumpedSettings(dumped, prior?.settings ?? {}, accountIdByName);
  const { userId: _u, settings: _s, ...otherColumns } = prior ?? ({} as Partial<typeof userSettings.$inferSelect>);
  void _u;
  void _s;
  await tx
    .insert(userSettings)
    .values({ ...otherColumns, userId: uid, settings, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userSettings.userId, set: { settings, updatedAt: new Date() } });
}
