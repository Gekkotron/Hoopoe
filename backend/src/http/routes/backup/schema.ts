import { z } from 'zod';
import { LoanBody } from '../loans/schemas.js';

// Versioned envelope. Bump `version` when the shape changes in a non-additive
// way — the importer refuses unknown versions outright.
//
// Transaction attachments (migration 0034) travel via a SEPARATE archive
// channel — see backup/attachments-archive.ts and
// domain/backup/attachments-archive.ts. They are NOT inlined in this JSON
// dump because each attachment can be up to 10 MB and would inflate the
// envelope (and multiply the passphrase-encrypt cost) by orders of magnitude.
// The archive is encrypted the same way (AES-256-GCM under a scrypt-derived
// key) but ships as raw binary (gzip'd JSON, not JSON-inside-JSON) so a heavy
// receipt library stays cheap to move. On restore, the two channels operate
// independently: restoring the JSON dump alone wipes attachment rows via
// CASCADE and leaves files orphaned on disk; restoring the attachments
// archive rebuilds both DB + disk from its own payload. Users are expected
// to grab both files for a full snapshot.
//
// v5 (additive) adds: envelopeAssignments, envelopeCategorySettings,
// envelopeMonthHolds, recurringSeries (with links to dump transactions by
// array index), pdfStatementTemplates, fxRates and userSettings. Every new
// field is optional, so v1-v4 dumps still parse and restore as before. An
// older dump cannot preserve the areas that hang off accounts/categories
// (envelopes, recurring series, PDF templates): the restore wipes those like
// every other account/category-owned table. It leaves user_settings, fx_rates
// and envelope_month_holds untouched, since those only belong to the user.
// pdf_import_drafts are transient parked uploads (24h expiry) and are never
// dumped.
export const VERSION = 5;

const categoryKind = z.enum(['expense', 'income', 'transfer', 'neutral']);
const signConstraint = z.enum(['positive', 'negative', 'any']);
const matchMode = z.enum(['word', 'substring', 'regex']);
const categorySource = z.enum(['manual', 'auto', 'default', 'llm']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const signedAmount = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

export const BackupBody = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  accounts: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      currency: z.string(),
      openingBalance: z.string(),
      openingDate: z.string(),
      // Added later; optional so older backups that omit it still validate.
      // Missing displayOrder defaults to 0 on import.
      displayOrder: z.number().int().optional(),
      // Lock-period default (migration 0011). Optional for backward compat.
      lockYears: z.number().int().min(0).max(99).nullable().optional(),
      // Legacy field (migration 0017, dropped in 0018). Kept optional so v2
      // backups still validate; the importer translates isInvestment=true
      // into type='investment' before insert.
      isInvestment: z.boolean().optional(),
    }),
  ),
  categories: z.array(
    z.object({
      name: z.string(),
      kind: categoryKind,
      color: z.string().nullable().optional(),
      parent: z.string().nullable().optional(),
      isDefault: z.boolean(),
      // Added in migration 0012. Optional so pre-0012 backups still validate;
      // missing means "false" (existing behaviour).
      isInternalTransfer: z.boolean().optional(),
    }),
  ),
  accountFilenamePatterns: z.array(
    z.object({
      pattern: z.string(),
      account: z.string().nullable(),
      priority: z.number().int(),
    }),
  ),
  rules: z.array(
    z.object({
      keyword: z.string(),
      category: z.string().nullable(),
      // Disambiguates same-name sub-categories under different parents
      // (migration 0019's unique index scopes on parent). Absent on v3 and
      // older dumps; null means "root category" on v4+ dumps.
      categoryParent: z.string().nullable().optional(),
      signConstraint,
      matchMode,
      priority: z.number().int(),
      enabled: z.boolean(),
      // Rule-driven auto-splits (migration 0042). Absent on all pre-0042
      // dumps and on any single-category rule. When present, restore
      // resolves each entry's category the same way rules resolve theirs
      // (`category` + `categoryParent`) — any unresolved entry drops the
      // whole rule (silently dropping only one split would break the
      // sum=100 invariant), and the count surfaces in the response summary.
      splits: z.array(
        z.object({
          category: z.string().nullable(),
          categoryParent: z.string().nullable().optional(),
          percent: z.number().int().min(1).max(99),
        }),
      ).optional(),
    }),
  ),
  // (transferRules were dropped as a feature — any legacy field on an old dump
  // is silently stripped by zod's default .strip() behavior on parse.)
  // Per-account balance checkpoints (migration 0009). Optional for
  // backward compatibility with pre-fix exports that omit the field.
  balanceCheckpoints: z.array(
    z.object({
      account: z.string(),
      checkpointDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      expectedAmount: z.string(),
      note: z.string().nullable().optional(),
    }),
  ).optional(),
  transactions: z.array(
    z.object({
      account: z.string(),
      date: z.string(),
      amount: z.string(),
      rawLabel: z.string(),
      normalizedLabel: z.string(),
      memo: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
      fitid: z.string().nullable().optional(),
      dedupKey: z.string(),
      category: z.string().nullable().optional(),
      // See `rules[].categoryParent` above.
      categoryParent: z.string().nullable().optional(),
      categorySource,
      transferGroupId: z.string().nullable().optional(),
      // Natural-key reference to a fileImports row in the same backup.
      // Shape: "<filename>|<importedAt-ISO>". Missing means "no source file".
      sourceFileKey: z.string().nullable().optional(),
      // Validated as "not a duplicate" via the Possibles doublons panel.
      // Optional for backward compatibility with pre-fix exports.
      notDuplicate: z.boolean().optional(),
      // Per-transaction lock override (migration 0011). Optional for
      // backward compatibility.
      lockYears: z.number().int().min(0).max(99).nullable().optional(),
      // Ventilation across categories (migration 0014). Optional so v1
      // backups without splits still validate.
      splits: z.array(
        z.object({
          category: z.string().nullable(),
          // See `rules[].categoryParent` above.
          categoryParent: z.string().nullable().optional(),
          amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
          memo: z.string().nullable().optional(),
        }),
      ).optional(),
    }),
  ),
  // Audit trail of past imports — the rows that power the Imports → Historique
  // table. Optional for backward compatibility with pre-fix exports.
  fileImports: z.array(
    z.object({
      account: z.string(),
      filename: z.string(),
      // Mirrors the import_format DB enum. 'bank-sync' arrived in migration
      // 0030, 'camt' in 0037 — both must be accepted here or a restore of a
      // dump containing those audit rows would fail zod validation.
      format: z.enum(['ofx', 'csv', 'pdf', 'bank-sync', 'camt']),
      importedAt: z.string(),
      totalLines: z.number().int(),
      insertedCount: z.number().int(),
      dedupSkipped: z.number().int(),
      userSkipped: z.number().int().default(0),
      statedBalance: z.string().nullable().optional(),
      statedBalanceDate: z.string().nullable().optional(),
    }),
  ).optional(),
  // Category budgets (migration 0015; period + account added in 0021).
  // Optional so pre-0015 backups still validate. Referenced by category name;
  // restore skips a budget whose category did not restore.
  // `period` and `account` are v2 additions; both optional so pre-v2 backups
  // still validate (defaults: 'monthly' / null).
  budgets: z.array(
    z.object({
      category: z.string().nullable(),
      // See `rules[].categoryParent` above.
      categoryParent: z.string().nullable().optional(),
      monthlyLimit: z.string().regex(/^\d+(\.\d{1,2})?$/).refine((s) => Number(s) > 0, 'must be greater than 0'),
      currency: z.string(),
      period: z.enum(['monthly', 'yearly']).optional().default('monthly'),
      account: z.string().nullable().optional(), // account name; null = global
    }),
  ).optional(),
  // Savings goals (migration 0037). Optional so pre-0037 backups still
  // validate. Natural key on restore is (accountName, goalName); events
  // reference their goal by that same pair.
  savingsGoals: z.array(
    z.object({
      account: z.string(),
      name: z.string(),
      targetAmount: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
      targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      color: z.string().nullable().optional(),
      closedAt: z.string().nullable().optional(),
    }),
  ).optional(),
  savingsGoalEvents: z.array(
    z.object({
      account: z.string(),
      goal: z.string(),
      amount: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
      eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note: z.string().nullable().optional(),
    }),
  ).optional(),
  // Investment valuations (migration 0047). Optional so older backups still
  // validate. Referenced by account name; restore skips a row whose account
  // did not restore.
  accountValuations: z.array(
    z.object({
      account: z.string(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      value: z.string().regex(/^-?\d+(\.\d{1,2})?$/),
      source: z.string().optional(),
    }),
  ).optional(),
  // Loans (migration 0048). Natural key is the loan name; a simulation
  // points at its source loan by name. Optional so older dumps restore.
  loans: z.array(
    LoanBody.omit({ sourceLoanId: true }).extend({
      sourceLoan: z.string().nullable(),
      createdAt: z.string().datetime().optional(),
      updatedAt: z.string().datetime().optional(),
    }),
  ).optional(),
  // --- v5 additions (all optional; see the VERSION comment) ---
  // Envelope budgeting. Categories are referenced by (name, parent name),
  // like budgets; a row whose category did not restore is skipped.
  envelopeAssignments: z.array(
    z.object({
      category: z.string(),
      categoryParent: z.string().nullable().optional(),
      month: isoDate,
      amount: signedAmount,
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
  ).optional(),
  envelopeCategorySettings: z.array(
    z.object({
      category: z.string(),
      categoryParent: z.string().nullable().optional(),
      targetAmount: signedAmount.nullable(),
      targetDate: isoDate.nullable(),
      targetKind: z.enum(['save_by_date', 'monthly_recurring', 'save_up_to']).nullable(),
      overspendPolicy: z.enum(['rollover_negative', 'reallocate_manual']),
    }),
  ).optional(),
  envelopeMonthHolds: z.array(
    z.object({ month: isoDate, amount: signedAmount }),
  ).optional(),
  // Detected recurring series. `transactions` lists the series' member
  // transactions as 0-based indices into this dump's `transactions` array
  // (transactions have no natural key).
  recurringSeries: z.array(
    z.object({
      label: z.string(),
      cadenceDays: z.number().int(),
      avgAmount: signedAmount,
      amountStddev: signedAmount,
      category: z.string().nullable(),
      categoryParent: z.string().nullable().optional(),
      firstSeenAt: isoDate,
      lastSeenAt: isoDate,
      nextDueAt: isoDate,
      status: z.enum(['detected', 'confirmed', 'dismissed']),
      essentialness: z.enum(['essential', 'discretionary']).nullable(),
      transactions: z.array(z.number().int().min(0)),
    }),
  ).optional(),
  // Learned PDF statement layouts. `account` null = a layout not tied to an
  // account.
  pdfStatementTemplates: z.array(
    z.object({
      fingerprint: z.string(),
      account: z.string().nullable(),
      label: z.string(),
      zones: z.record(z.string(), z.unknown()),
      source: z.string(),
    }),
  ).optional(),
  fxRates: z.array(
    z.object({
      from: z.string().regex(/^[A-Z]{3}$/),
      to: z.string().regex(/^[A-Z]{3}$/),
      effectiveFrom: isoDate,
      rate: z.string().regex(/^\d+(\.\d{1,10})?$/),
    }),
  ).optional(),
  // The user_settings JSON with the notification secrets (Discord webhook,
  // CallMeBot key, plaintext or encrypted) removed, and the keys that hold
  // account database ids moved out into `accountRefs` by account name.
  userSettings: z.object({
    settings: z.record(z.string(), z.unknown()),
    accountRefs: z.object({
      transactionsDefaultAccount: z.string().nullable().optional(),
      dashboardChartScope: z.string().nullable().optional(),
      bigTransactionThresholds: z.record(z.string(), z.number()).optional(),
      accountLowFloors: z.record(z.string(), z.number()).optional(),
    }).optional(),
  }).optional(),
});

export type BackupDump = z.infer<typeof BackupBody>;

// Natural key for cross-referencing a fileImports row from a transaction —
// exports emit `sourceFileKey: "<filename>|<importedAt-ISO>"` so restore can
// re-link transactions to file_imports even though DB ids get regenerated.
export function fileImportKey(filename: string, importedAtISO: string): string {
  return `${filename}|${importedAtISO}`;
}
