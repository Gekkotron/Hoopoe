import { createHash } from 'node:crypto';

export interface DedupInput {
  accountId: number;
  date: string;           // YYYY-MM-DD
  amount: string;         // signed decimal string e.g. "-25.30"
  normalizedLabel: string;
  fitid?: string | null;
}

// FITID is the bank-provided unique transaction id (when present in an OFX
// file). If the bank provides one we trust it — it survives label edits, time
// zones, etc. Otherwise we hash a tuple that's stable across re-imports.
//
// Without a FITID, two real transactions can share the whole tuple (two
// coffees at the same price on the same day). The key therefore carries an
// occurrence number: the n-th identical row of one file / statement /
// manual entry gets `#n`. Re-importing the same file yields the same
// numbers, so idempotency holds, and the second coffee is no longer dropped.
//
//   hash2:<sha256("<sha1 hex of account|date|amount|label>|#<n>")>
//
// The sha1 inner hash is the pre-2026-11 `hash:<hex>` key. Building on it
// lets migration 0050 (and backup restore) upgrade every stored key from
// the key alone — rows edited since import keep their original identity.
// The prefix tells at a glance how a row was deduped.

function legacyHex(t: DedupInput): string {
  const material = `${t.accountId}|${t.date}|${t.amount}|${t.normalizedLabel}`;
  return createHash('sha1').update(material).digest('hex');
}

function hashKey(legacy: string, occurrence: number): string {
  return `hash2:${createHash('sha256').update(`${legacy}|#${occurrence}`).digest('hex')}`;
}

function fitidKey(t: DedupInput): string | null {
  return t.fitid && t.fitid.trim() ? `fitid:${t.fitid.trim()}` : null;
}

// Key for one row. `occurrence` is 1-based; ignored when the row has a FITID.
export function computeDedupKey(t: DedupInput, occurrence = 1): string {
  if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error(`invalid dedup occurrence ${occurrence}`);
  return fitidKey(t) ?? hashKey(legacyHex(t), occurrence);
}

// Keys for a whole file / statement, in order: identical FITID-less rows get
// #1, #2, … in the order they appear. Callers must pass every parsed row
// (before user skips) so preview, import and reconcile number alike.
export function computeDedupKeys(rows: readonly DedupInput[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((t) => {
    const fitid = fitidKey(t);
    if (fitid) return fitid;
    const legacy = legacyHex(t);
    const n = (seen.get(legacy) ?? 0) + 1;
    seen.set(legacy, n);
    return hashKey(legacy, n);
  });
}

// Candidate keys #1..#max for one row, used by manual "add anyway" to pick
// the first free occurrence. A FITID row has a single candidate.
export function dedupKeyCandidates(t: DedupInput, max: number): string[] {
  const fitid = fitidKey(t);
  if (fitid) return [fitid];
  const legacy = legacyHex(t);
  return Array.from({ length: max }, (_, i) => hashKey(legacy, i + 1));
}

// Upgrades a pre-2026-11 `hash:<sha1 hex>` key (old backups, attachment
// archives) to the current scheme as occurrence #1. Same mapping as
// migration 0050. Any other key is returned unchanged.
export function upgradeLegacyDedupKey(key: string): string {
  const m = /^hash:([0-9a-f]{40})$/.exec(key);
  return m ? hashKey(m[1]!, 1) : key;
}
