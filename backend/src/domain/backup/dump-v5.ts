import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  envelopeAssignments,
  envelopeCategorySettings,
  envelopeMonthHolds,
  fxRates,
  pdfStatementTemplates,
  recurringSeries,
  recurringSeriesTransactions,
  userSettings,
} from '../../db/schema.js';
import type { accounts, categories, transactions } from '../../db/schema.js';
import { toDumpedSettings } from './settings-dump.js';

// The v5 sections of the portable dump (see VERSION in
// http/routes/backup/schema.ts). Split out of dump.ts to keep both files
// readable; buildDump() spreads the result into the dump.

export async function loadV5Rows(uid: number) {
  const [assignments, categorySettings, holds, series, seriesLinks, templates, rates, settingsRows] =
    await Promise.all([
      db.select().from(envelopeAssignments).where(eq(envelopeAssignments.userId, uid)),
      db.select().from(envelopeCategorySettings).where(eq(envelopeCategorySettings.userId, uid)),
      db.select().from(envelopeMonthHolds).where(eq(envelopeMonthHolds.userId, uid)),
      db.select().from(recurringSeries).where(eq(recurringSeries.userId, uid)),
      db
        .select()
        .from(recurringSeriesTransactions)
        .innerJoin(recurringSeries, eq(recurringSeriesTransactions.seriesId, recurringSeries.id))
        .where(eq(recurringSeries.userId, uid))
        .then((rows) => rows.map((r) => r.recurring_series_transactions)),
      db.select().from(pdfStatementTemplates).where(eq(pdfStatementTemplates.userId, uid)),
      db.select().from(fxRates).where(eq(fxRates.userId, uid)),
      // Only the settings JSON column: mcp_key_wrapped / mcp_enabled /
      // mcp_read_only / dismissed_tips are never selected, let alone dumped.
      db.select({ settings: userSettings.settings }).from(userSettings).where(eq(userSettings.userId, uid)),
    ]);
  return { assignments, categorySettings, holds, series, seriesLinks, templates, rates, settingsRows };
}

type V5Rows = Awaited<ReturnType<typeof loadV5Rows>>;

type Ctx = {
  accs: Array<typeof accounts.$inferSelect>;
  txs: Array<typeof transactions.$inferSelect>;
  categoryById: Map<number, typeof categories.$inferSelect>;
  accountById: Map<number, typeof accounts.$inferSelect>;
  categoryParentName: (catId: number | null) => string | null;
};

export function buildV5Sections(rows: V5Rows, ctx: Ctx) {
  const { accs, txs, categoryById, accountById, categoryParentName } = ctx;

  // Series link to transactions by 0-based index into the dump's
  // `transactions` array: transactions have no natural key, and the index is
  // the same mechanism restore already uses to fan splits out to their parent
  // (restoreTransactions fills an index -> new id map for the series restore).
  const txIndexById = new Map(txs.map((t, i) => [t.id, i]));
  const linksBySeries = new Map<number, number[]>();
  for (const l of rows.seriesLinks) {
    const idx = txIndexById.get(l.transactionId);
    if (idx === undefined) continue;
    const arr = linksBySeries.get(l.seriesId) ?? [];
    arr.push(idx);
    linksBySeries.set(l.seriesId, arr);
  }

  const settingsRow = rows.settingsRows[0];
  return {
    counts: {
      envelopeAssignments: rows.assignments.length,
      envelopeCategorySettings: rows.categorySettings.length,
      envelopeMonthHolds: rows.holds.length,
      recurringSeries: rows.series.length,
      pdfStatementTemplates: rows.templates.length,
      fxRates: rows.rates.length,
    },
    sections: {
      envelopeAssignments: rows.assignments.map((a) => ({
        category: categoryById.get(a.categoryId)?.name ?? '',
        categoryParent: categoryParentName(a.categoryId),
        month: a.month,
        amount: a.amount,
        currency: a.currency,
      })),
      envelopeCategorySettings: rows.categorySettings.map((e) => ({
        category: categoryById.get(e.categoryId)?.name ?? '',
        categoryParent: categoryParentName(e.categoryId),
        targetAmount: e.targetAmount,
        targetDate: e.targetDate,
        targetKind: e.targetKind as 'save_by_date' | 'monthly_recurring' | 'save_up_to' | null,
        overspendPolicy: e.overspendPolicy as 'rollover_negative' | 'reallocate_manual',
      })),
      envelopeMonthHolds: rows.holds.map((h) => ({ month: h.month, amount: h.amount })),
      recurringSeries: rows.series.map((r) => ({
        label: r.label,
        cadenceDays: r.cadenceDays,
        avgAmount: r.avgAmount,
        amountStddev: r.amountStddev,
        category: r.categoryId != null ? categoryById.get(r.categoryId)?.name ?? null : null,
        categoryParent: categoryParentName(r.categoryId),
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        nextDueAt: r.nextDueAt,
        status: r.status,
        essentialness: r.essentialness,
        transactions: (linksBySeries.get(r.id) ?? []).sort((a, b) => a - b),
      })),
      // pdf_import_drafts are transient parked uploads (24h expiry): not dumped.
      pdfStatementTemplates: rows.templates.map((t) => ({
        fingerprint: t.fingerprint,
        account: t.accountId != null ? accountById.get(t.accountId)?.name ?? null : null,
        label: t.label,
        zones: t.zones as Record<string, unknown>,
        source: t.source,
      })),
      fxRates: rows.rates.map((r) => ({
        from: r.fromCcy,
        to: r.toCcy,
        effectiveFrom: r.effectiveFrom,
        rate: r.rate,
      })),
      userSettings: settingsRow
        ? toDumpedSettings(settingsRow.settings, new Map(accs.map((a) => [a.id, a.name])))
        : undefined,
    },
  };
}
