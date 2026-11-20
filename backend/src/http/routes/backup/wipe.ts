import { eq, sql } from 'drizzle-orm';
import type { db } from '../../../db/client.js';
import {
  accounts,
  accountValuations,
  accountFilenamePatterns,
  balanceCheckpoints,
  bankConnectionAccounts,
  bankConnections,
  categories,
  categoryBudgets,
  envelopeMonthHolds,
  fileImports,
  fxRates,
  loans,
  pdfStatementTemplates,
  recurringSeries,
  ruleSplits,
  rules,
  savingsGoalEvents,
  savingsGoals,
  transactionAttachments,
  transactions,
  transactionSplits,
  users,
  userSettings,
  userTotp,
  userTotpRecoveryCodes,
} from '../../../db/schema.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// A bank_connection_accounts row as it stood before the wipe, plus the name of
// the Hoopoe account it was mapped to. The restore re-links by that name.
export type BankLinkSnapshot = {
  id: number;
  connectionId: number;
  bankAccountUid: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  lastSyncedAt: Date | null;
  previousAccountName: string | null;
};

// Which optional (v5) sections the dump being restored carries. A section is
// only wiped when the dump carries it, so an older dump never destroys data it
// has no way to bring back.
export type WipeScope = {
  userSettings?: boolean;
  fxRates?: boolean;
  envelopeMonthHolds?: boolean;
  pdfStatementTemplates?: boolean;
  recurringSeries?: boolean;
};

export type WipeSnapshot = {
  bankLinks: BankLinkSnapshot[];
  // The caller's full user_settings row as it stood before the wipe (null when
  // none, or when the dump does not carry settings). Needed because the
  // TRUNCATE path empties the table, and the row also holds columns the dump
  // never carries (MCP key, dismissed tips): the restore re-inserts them.
  userSettingsRow: typeof userSettings.$inferSelect | null;
};

async function snapshotBankLinks(tx: Tx, uid: number): Promise<BankLinkSnapshot[]> {
  const rows = await tx
    .select({
      id: bankConnectionAccounts.id,
      connectionId: bankConnectionAccounts.connectionId,
      bankAccountUid: bankConnectionAccounts.bankAccountUid,
      iban: bankConnectionAccounts.iban,
      name: bankConnectionAccounts.name,
      currency: bankConnectionAccounts.currency,
      lastSyncedAt: bankConnectionAccounts.lastSyncedAt,
      previousAccountName: accounts.name,
    })
    .from(bankConnectionAccounts)
    .innerJoin(bankConnections, eq(bankConnections.id, bankConnectionAccounts.connectionId))
    .leftJoin(accounts, eq(accounts.id, bankConnectionAccounts.accountId))
    .where(eq(bankConnections.userId, uid));
  return rows;
}

// Restore's REPLACE-semantics wipe.
//
// Sole-user installs (the desktop app always; solo LAN setups) wipe via
// TRUNCATE instead of per-user DELETEs. Beyond being O(1), this is a
// PGlite-survival requirement: a DELETE that visits a tuple whose xmax was
// written by a crashed session busy-waits forever in single-user WASM
// Postgres (observed as a restore pinned at 100% CPU). TRUNCATE swaps the
// relation's storage without inspecting tuples, so it is immune. The list
// mirrors what the DELETE path removes directly or via FK cascade
// (recurring_series husks additionally go — they'd only survive as empty
// shells with dead transaction links).
//
// Bank links: bank_connection_accounts.account_id is ON DELETE SET NULL, so
// the DELETE path nulls the mapping of the rows it keeps, while a
// TRUNCATE ... CASCADE would silently empty the whole table and leave bank
// connections with no accounts (sync then does nothing). Both paths therefore
// snapshot the caller's links (with the mapped account's name) up front, and
// the restore re-links them by account name once accounts are re-inserted
// (see relinkBankAccounts). The TRUNCATE lists bank_connection_accounts
// explicitly and re-inserts the snapshot (same ids) rather than switching to
// UPDATE/DELETE, which would reintroduce the PGlite busy-wait above.
//
// The TRUNCATE has no CASCADE: every table with an FK into the truncated set
// must be listed, and Postgres errors out if a new one is forgotten instead of
// silently emptying it. Audit of FKs into accounts/categories/transactions/
// rules/etc.: every referencing table is in the list except
// bank_connection_accounts (handled above, now listed). Tables referencing
// only users (user_settings, notifications, fx_rates, envelope_month_holds,
// backup_destinations, bank_connections, bank_sync_credentials) are untouched
// by default. Only when the dump carries the matching v5 section (see
// WipeScope) are fx_rates, envelope_month_holds and user_settings replaced
// too. In the TRUNCATE path that is a TRUNCATE for the same busy-wait reason
// as above; user_settings is additionally snapshotted first and re-inserted by
// the restore, because the row holds secrets the dump never carries. In the
// per-user path they are scoped DELETEs (user_settings is upserted instead).
// recurring_series and pdf_statement_templates: the TRUNCATE path always
// empties them; the per-user path only removes the caller's rows when the
// dump carries them, otherwise series husks and account-less templates stay.
// Series and templates tied to an account/category cannot be kept across a
// restore from an older dump: the account/category rows they hang off are
// replaced.
export async function wipeUserData(
  tx: Tx,
  uid: number,
  scope: WipeScope = {},
): Promise<WipeSnapshot> {
  const bankLinks = await snapshotBankLinks(tx, uid);
  let userSettingsRow: WipeSnapshot['userSettingsRow'] = null;
  if (scope.userSettings) {
    const [row] = await tx.select().from(userSettings).where(eq(userSettings.userId, uid));
    userSettingsRow = row ?? null;
  }
  const snapshot: WipeSnapshot = { bankLinks, userSettingsRow };
  const [userCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
  if ((userCount?.n ?? 0) === 1) {
    // Fixed identifiers only (never user input), so sql.raw is safe here.
    const optionalTables = [
      scope.fxRates ? 'fx_rates' : null,
      scope.envelopeMonthHolds ? 'envelope_month_holds' : null,
      scope.userSettings ? 'user_settings' : null,
    ].filter((t): t is string => t !== null);
    const extra = optionalTables.length > 0 ? sql.raw(`${optionalTables.join(', ')}, `) : sql.raw('');
    await tx.execute(sql`TRUNCATE
      ${extra}user_totp_recovery_codes, user_totp,
      savings_goal_events, savings_goals,
      account_valuations, loans,
      transaction_splits, transaction_attachments,
      rule_splits,
      recurring_series_transactions, recurring_series,
      envelope_assignments, envelope_category_settings,
      pdf_import_drafts, pdf_statement_templates,
      transactions, file_imports, rules,
      balance_checkpoints, category_budgets, account_filename_patterns,
      bank_connection_accounts,
      categories, accounts`);
    if (bankLinks.length > 0) {
      await tx.insert(bankConnectionAccounts).values(
        bankLinks.map(({ previousAccountName: _name, ...row }) => ({ ...row, accountId: null })),
      );
    }
    return snapshot;
  }

  // Wipe only THIS user's rows, in reverse dependency order.
  // Splits and attachments both cascade-delete when the parent transactions
  // go, but we drop them explicitly to keep the ordering readable. Orphan
  // attachment files on disk (DATA_DIR/attachments/<user_id>/…) are NOT
  // cleaned up here — the on-disk sweep is out of scope for the wipe path;
  // see backup/schema.ts for the deferred-attachments rationale.
  // Savings goals: events cascade via goal_id, but delete explicitly to keep
  // ordering readable and to match the transaction_attachments precedent.
  // TOTP secret + recovery codes: 2FA is per-device, so a restore into
  // a wiped install re-enrols. Cascades via userTotp, but delete both
  // explicitly to keep ordering readable.
  await tx.delete(userTotpRecoveryCodes).where(eq(userTotpRecoveryCodes.userId, uid));
  await tx.delete(userTotp).where(eq(userTotp.userId, uid));
  await tx.delete(savingsGoalEvents).where(eq(savingsGoalEvents.userId, uid));
  await tx.delete(savingsGoals).where(eq(savingsGoals.userId, uid));
  await tx.delete(accountValuations).where(eq(accountValuations.userId, uid));
  await tx.delete(loans).where(eq(loans.userId, uid));
  if (scope.fxRates) await tx.delete(fxRates).where(eq(fxRates.userId, uid));
  if (scope.envelopeMonthHolds) await tx.delete(envelopeMonthHolds).where(eq(envelopeMonthHolds.userId, uid));
  if (scope.recurringSeries) await tx.delete(recurringSeries).where(eq(recurringSeries.userId, uid));
  if (scope.pdfStatementTemplates) {
    await tx.delete(pdfStatementTemplates).where(eq(pdfStatementTemplates.userId, uid));
  }
  await tx.delete(transactionAttachments).where(eq(transactionAttachments.userId, uid));
  await tx.delete(transactionSplits)
    .where(sql`transaction_id IN (SELECT id FROM transactions WHERE user_id = ${uid})`);
  await tx.delete(transactions).where(eq(transactions.userId, uid));
  await tx.delete(fileImports).where(eq(fileImports.userId, uid));
  // rule_splits cascades via rule_id ON DELETE CASCADE from the DELETE
  // below, but drop them explicitly first to match the transaction_splits
  // + transaction_attachments precedent (explicit ordering keeps this
  // section readable when a new table joins the chain).
  await tx.delete(ruleSplits)
    .where(sql`rule_id IN (SELECT id FROM rules WHERE user_id = ${uid})`);
  await tx.delete(rules).where(eq(rules.userId, uid));
  await tx.delete(balanceCheckpoints).where(eq(balanceCheckpoints.userId, uid));
  await tx.delete(categoryBudgets).where(eq(categoryBudgets.userId, uid));
  await tx.delete(accountFilenamePatterns).where(eq(accountFilenamePatterns.userId, uid));
  await tx.delete(categories).where(eq(categories.userId, uid));
  await tx.delete(accounts).where(eq(accounts.userId, uid));
  // bank_connection_accounts rows survive with account_id nulled by the FK.
  return snapshot;
}
