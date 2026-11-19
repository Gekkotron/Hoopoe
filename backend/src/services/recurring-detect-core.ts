// Pure detection primitives. No DB, no env, no side effects — just
// clustering + cadence-fitting over a list of transaction rows. The
// DB-touching wrapper (runRecurringDetection) lives in
// recurring-detect.ts and pulls this in.
//
// Split out so the unit test can exercise the algorithm without
// booting env.ts / db/client.ts (which require SESSION_SECRET and a
// live driver).
import { tokenize } from '../lib/label-similarity.js';
import { addDays } from '../domain/transfers/matching.js';

// Detection knobs. Kept module-scoped so callers can't drift them
// silently — tune here, not at the callsite.
export const SIMILARITY_THRESHOLD = 0.5;
export const CADENCE_TOLERANCE = 0.2;
export const AMOUNT_TOLERANCE = 0.15;
export const CADENCE_BUCKETS = [7, 30, 90, 365] as const;
export const MIN_OCCURRENCES = 3;

export interface DetectionInputTx {
  id: number;
  date: string;
  amount: string;
  rawLabel: string;
  categoryId: number | null;
}

export interface DetectedSeries {
  label: string;
  cadenceDays: number;
  avgAmount: number;
  amountStddev: number;
  categoryId: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  nextDueAt: string;
  memberIds: number[];
}

export function todayIso(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function isoDaysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split('-').map(Number) as [number, number, number];
  const [yb, mb, db2] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(yb, mb - 1, db2) - Date.UTC(ya, ma - 1, da)) / 86_400_000);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function sampleStddev(nums: number[], mean: number): number {
  if (nums.length < 2) return 0;
  const v = nums.reduce((acc, n) => acc + (n - mean) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

// Majority-vote mode: returns the value only when it appears in > 50% of the
// samples. Ties and pluralities-below-majority return null so the caller
// falls back to "unassigned" rather than an arbitrary pick.
function majorityMode<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) {
      bestCount = v;
      best = k;
    }
  }
  return bestCount * 2 > arr.length ? best : null;
}

// Greedy clustering: for each transaction, join the first existing cluster
// (in creation order) whose representative label passes the Jaccard
// threshold; otherwise start a new cluster. A similarity >= SIMILARITY_THRESHOLD
// (> 0) needs at least one shared token, so an inverted index from rep token to
// cluster indices narrows the candidates instead of scanning every cluster for
// every transaction (the full scan tokenised both labels per pair and took
// tens of seconds on a 20k-transaction year). Labels with no tokens only
// match reps with no tokens (similarity 1), tracked separately.
function clusterByLabel(txs: DetectionInputTx[]): DetectionInputTx[][] {
  const clusters: { repTokens: Set<string>; members: DetectionInputTx[] }[] = [];
  const byToken = new Map<string, number[]>();
  const emptyRepClusters: number[] = [];

  const similarity = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };

  for (const t of txs) {
    const tokens = tokenize(t.rawLabel);
    let candidates: number[];
    if (tokens.size === 0) {
      candidates = emptyRepClusters;
    } else {
      const seen = new Set<number>();
      for (const tok of tokens) {
        for (const idx of byToken.get(tok) ?? []) seen.add(idx);
      }
      candidates = [...seen].sort((x, y) => x - y);
    }
    let landed = false;
    for (const idx of candidates) {
      const c = clusters[idx]!;
      if (similarity(tokens, c.repTokens) >= SIMILARITY_THRESHOLD) {
        c.members.push(t);
        landed = true;
        break;
      }
    }
    if (!landed) {
      const idx = clusters.length;
      clusters.push({ repTokens: tokens, members: [t] });
      if (tokens.size === 0) emptyRepClusters.push(idx);
      for (const tok of tokens) {
        const list = byToken.get(tok);
        if (list) list.push(idx);
        else byToken.set(tok, [idx]);
      }
    }
  }
  return clusters.map((c) => c.members);
}

// Try to fit a single label-cluster to a fixed cadence bucket. Returns null
// when no bucket matches, when the amount spread is too wide, or when the
// resulting chain is too short to be a real pattern.
function fitCadence(cluster: DetectionInputTx[]): DetectedSeries | null {
  if (cluster.length < MIN_OCCURRENCES) return null;

  const sorted = [...cluster].sort((a, b) => a.date.localeCompare(b.date));
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(isoDaysBetween(sorted[i - 1]!.date, sorted[i]!.date));
  }
  if (intervals.length === 0) return null;
  const medIvl = median(intervals);

  // Prefer the smallest cadence that fits — a monthly rent shouldn't be
  // mistaken for a quarterly one just because the ranges could overlap.
  let cadence: number | null = null;
  for (const b of CADENCE_BUCKETS) {
    if (medIvl >= b * (1 - CADENCE_TOLERANCE) && medIvl <= b * (1 + CADENCE_TOLERANCE)) {
      cadence = b;
      break;
    }
  }
  if (cadence === null) return null;

  // Amount filter: keep transactions within ±15% of the cluster's median
  // amount. Utility bills that vary month-to-month are the target here.
  const amounts = sorted.map((t) => Number(t.amount));
  const medAmt = median(amounts);
  const filtered = sorted.filter((t) => {
    const a = Number(t.amount);
    const tolerance = Math.abs(medAmt) * AMOUNT_TOLERANCE;
    return Math.abs(a - medAmt) <= tolerance;
  });
  if (filtered.length < MIN_OCCURRENCES) return null;

  const first = filtered[0]!.date;
  const last = filtered[filtered.length - 1]!.date;
  if (isoDaysBetween(first, last) < 2 * cadence) return null;

  const filteredAmounts = filtered.map((t) => Number(t.amount));
  const meanAmt = filteredAmounts.reduce((s, a) => s + a, 0) / filteredAmounts.length;
  const std = sampleStddev(filteredAmounts, meanAmt);

  // Canonical label = most-frequent rawLabel among the filtered members.
  const labelCounts = new Map<string, number>();
  for (const t of filtered) labelCounts.set(t.rawLabel, (labelCounts.get(t.rawLabel) ?? 0) + 1);
  const bestLabel = [...labelCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  return {
    label: bestLabel,
    cadenceDays: cadence,
    avgAmount: meanAmt,
    amountStddev: std,
    categoryId: majorityMode(filtered.map((t) => t.categoryId)),
    firstSeenAt: first,
    lastSeenAt: last,
    nextDueAt: addDays(last, cadence),
    memberIds: filtered.map((t) => t.id),
  };
}

// Pure detection: same input → same output. Exported for unit testing so
// the algorithm can be exercised without a DB.
export function detectSeries(txs: DetectionInputTx[]): DetectedSeries[] {
  const clusters = clusterByLabel(txs);
  const out: DetectedSeries[] = [];
  for (const c of clusters) {
    const s = fitCadence(c);
    if (s) out.push(s);
  }
  return out;
}
