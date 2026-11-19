import { describe, it, expect } from 'vitest';
import { BudgetQuery, RangeQuery } from '../schemas.js';

describe('RangeQuery dates', () => {
  it('accepts a real calendar date', () => {
    expect(RangeQuery.safeParse({ fromDate: '2024-02-29' }).success).toBe(true);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2025-02-29'])(
    'rejects the impossible date %s instead of letting Postgres 500',
    (d) => {
      expect(RangeQuery.safeParse({ fromDate: d }).success).toBe(false);
      expect(RangeQuery.safeParse({ toDate: d }).success).toBe(false);
    },
  );
});

describe('BudgetQuery month', () => {
  it('accepts 01..12', () => {
    expect(BudgetQuery.safeParse({ month: '2026-01' }).success).toBe(true);
    expect(BudgetQuery.safeParse({ month: '2026-12' }).success).toBe(true);
  });

  it.each(['2026-00', '2026-13', '2026-99'])('rejects month %s (would roll into another period)', (m) => {
    expect(BudgetQuery.safeParse({ month: m }).success).toBe(false);
  });
});
