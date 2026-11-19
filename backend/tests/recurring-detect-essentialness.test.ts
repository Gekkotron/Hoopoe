// Regenerating detection deletes and rebuilds every 'detected' series. The
// essentialness tag the user set on such a row must survive the rebuild.
// Uses a hand-rolled tx double so it runs without a database.
import { describe, it, expect } from 'vitest';
import { recurringSeries, recurringSeriesTransactions, transactions } from '../src/db/schema.js';
import { runRecurringDetection } from '../src/services/recurring-detect.js';

type Row = Record<string, unknown>;

function fakeTx(txRows: Row[], existingSeries: Row[]) {
  const inserted: Row[][] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === transactions ? txRows : existingSeries),
      }),
    }),
    delete: () => ({ where: async () => undefined }),
    insert: (table: unknown) => ({
      values: (v: Row[]) => {
        if (table === recurringSeries) {
          inserted.push(v);
          return {
            onConflictDoUpdate: () => ({
              returning: async () => v.map((r, i) => ({ id: 100 + i, label: r.label, cadenceDays: r.cadenceDays })),
            }),
          };
        }
        expect(table).toBe(recurringSeriesTransactions);
        return Promise.resolve();
      },
    }),
  };
  return { tx, inserted };
}

const monthlyTxs = [
  { id: 1, date: '2026-04-15', amount: '-9.99', rawLabel: 'SPOTIFY', categoryId: null, transferGroupId: null },
  { id: 2, date: '2026-05-15', amount: '-9.99', rawLabel: 'SPOTIFY', categoryId: null, transferGroupId: null },
  { id: 3, date: '2026-06-14', amount: '-9.99', rawLabel: 'SPOTIFY', categoryId: null, transferGroupId: null },
  { id: 4, date: '2026-07-15', amount: '-9.99', rawLabel: 'SPOTIFY', categoryId: null, transferGroupId: null },
];

describe('runRecurringDetection essentialness carry-over', () => {
  it('re-applies the essentialness of a deleted detected row to its rebuilt row', async () => {
    const { tx, inserted } = fakeTx(monthlyTxs, [
      { label: 'SPOTIFY', cadenceDays: 30, status: 'detected', essentialness: 'discretionary' },
    ]);
    await runRecurringDetection(tx as never, 1, new Date('2026-07-20T00:00:00Z'));
    expect(inserted[0]![0]).toMatchObject({ label: 'SPOTIFY', essentialness: 'discretionary' });
  });

  it('leaves essentialness null when the detected row had none', async () => {
    const { tx, inserted } = fakeTx(monthlyTxs, [
      { label: 'SPOTIFY', cadenceDays: 30, status: 'detected', essentialness: null },
    ]);
    await runRecurringDetection(tx as never, 1, new Date('2026-07-20T00:00:00Z'));
    expect(inserted[0]![0]!.essentialness).toBeNull();
  });
});
