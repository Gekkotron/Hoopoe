import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeDedupKey, computeDedupKeys, dedupKeyCandidates, upgradeLegacyDedupKey, type DedupInput,
} from '../dedup.js';

const base: DedupInput = {
  accountId: 1,
  date: '2026-06-27',
  amount: '-25.30',
  normalizedLabel: 'carrefour',
};

describe('computeDedupKey', () => {
  it('is deterministic for identical rows', () => {
    expect(computeDedupKey(base)).toBe(computeDedupKey({ ...base }));
  });

  it('produces a prefixed sha256 hex hash without fitid', () => {
    expect(computeDedupKey(base)).toMatch(/^hash2:[0-9a-f]{64}$/);
  });

  it('pins the wire format: sha256 of the legacy sha1 hex plus the occurrence', () => {
    const legacy = createHash('sha1').update('1|2026-06-27|-25.30|carrefour').digest('hex');
    const want = createHash('sha256').update(`${legacy}|#2`).digest('hex');
    expect(computeDedupKey(base, 2)).toBe(`hash2:${want}`);
  });

  it('rejects a non-positive occurrence', () => {
    expect(() => computeDedupKey(base, 0)).toThrow();
  });

  it.each([
    ['accountId', { accountId: 2 }],
    ['date', { date: '2026-06-28' }],
    ['amount', { amount: '-25.31' }],
    ['normalizedLabel', { normalizedLabel: 'leclerc' }],
  ])('changes when %s changes', (_name, patch) => {
    expect(computeDedupKey({ ...base, ...patch })).not.toBe(computeDedupKey(base));
  });

  it('does not treat near-matching amounts as equal', () => {
    expect(computeDedupKey({ ...base, amount: '-25.30' })).not.toBe(
      computeDedupKey({ ...base, amount: '-25.3' }),
    );
  });

  it('uses the trimmed fitid when present', () => {
    expect(computeDedupKey({ ...base, fitid: '  ABC123 ' })).toBe('fitid:ABC123');
  });

  it('ignores other fields when fitid is present', () => {
    const a = computeDedupKey({ ...base, fitid: 'X1' });
    const b = computeDedupKey({ ...base, accountId: 9, amount: '1.00', fitid: 'X1' });
    expect(a).toBe(b);
  });

  it.each([null, undefined, '', '   '])('falls back to hash for fitid %j', (fitid) => {
    expect(computeDedupKey({ ...base, fitid })).toBe(computeDedupKey(base));
  });

  it('gives each occurrence a different key', () => {
    expect(computeDedupKey(base, 1)).not.toBe(computeDedupKey(base, 2));
  });
});

describe('computeDedupKeys', () => {
  it('numbers identical rows in order and leaves distinct rows at #1', () => {
    const other = { ...base, normalizedLabel: 'leclerc' };
    expect(computeDedupKeys([base, other, base, base])).toEqual([
      computeDedupKey(base, 1),
      computeDedupKey(other, 1),
      computeDedupKey(base, 2),
      computeDedupKey(base, 3),
    ]);
  });

  it('is stable across runs of the same file', () => {
    const rows = [base, base, { ...base, amount: '-1.00' }];
    expect(computeDedupKeys(rows)).toEqual(computeDedupKeys(rows));
  });

  it('keys FITID rows by FITID without consuming an occurrence', () => {
    expect(computeDedupKeys([{ ...base, fitid: 'A' }, base, base])).toEqual([
      'fitid:A', computeDedupKey(base, 1), computeDedupKey(base, 2),
    ]);
  });
});

describe('dedupKeyCandidates', () => {
  it('lists occurrences #1..#max', () => {
    expect(dedupKeyCandidates(base, 3)).toEqual([1, 2, 3].map((n) => computeDedupKey(base, n)));
  });

  it('has a single candidate for a FITID row', () => {
    expect(dedupKeyCandidates({ ...base, fitid: 'Z' }, 5)).toEqual(['fitid:Z']);
  });
});

describe('upgradeLegacyDedupKey', () => {
  it('maps a pre-0050 hash: key to occurrence #1 of the same row', () => {
    const legacy = createHash('sha1').update('1|2026-06-27|-25.30|carrefour').digest('hex');
    expect(upgradeLegacyDedupKey(`hash:${legacy}`)).toBe(computeDedupKey(base, 1));
  });

  it.each(['fitid:ABC', 'hash2:abc', 'hash:not-hex', 'manual:1'])('leaves %s unchanged', (k) => {
    expect(upgradeLegacyDedupKey(k)).toBe(k);
  });
});
