import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, categories } from '../db/schema.js';

// Cross-user isolation guards shared by routes and domain services. A
// foreign id and a missing id give the same answer, so callers can't probe
// which ids exist for other users.

export class AccountNotOwnedError extends Error {
  readonly code = 'account_not_found';
  constructor(readonly accountId: number) {
    super(`account ${accountId} not found`);
    this.name = 'AccountNotOwnedError';
  }
}

export async function isAccountOwned(uid: number, accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, uid)));
  return !!row;
}

// Throws AccountNotOwnedError when `accountId` is missing or belongs to
// another user. Domain entry points (runImport, importPdf, importPhoto,
// previewImport) call this so every caller is covered, not only the HTTP
// routes.
export async function assertOwnedAccount(uid: number, accountId: number): Promise<void> {
  if (!(await isAccountOwned(uid, accountId))) throw new AccountNotOwnedError(accountId);
}

// True when every id in `ids` is a category owned by `uid`. An empty list
// is trivially owned.
export async function areCategoriesOwned(uid: number, ids: readonly number[]): Promise<boolean> {
  const wanted = Array.from(new Set(ids));
  if (wanted.length === 0) return true;
  const owned = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.userId, uid), inArray(categories.id, wanted)));
  return owned.length === wanted.length;
}
