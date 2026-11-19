import { describe, it, expect } from 'vitest';
import { todayIso, toColumns, toRecord, toTerms, trimDecimal, type LoanRow } from '../src/domain/loans/record.js';

const row: LoanRow = {
  id: 7,
  userId: 1,
  name: 'Maison',
  kind: 'mortgage',
  isSimulation: false,
  sourceLoanId: null,
  currency: 'EUR',
  principal: '200000.00',
  startDate: '2026-02-05',
  annualRate: '3.5000',
  insuranceRate: '0.3450',
  insuranceBasis: 'remaining',
  insuranceMonthlyAmount: null,
  fees: '1200.00',
  periods: [{ kind: 'partial_deferral', months: 12 }],
  finalPeriod: { solve: 'payment', endDate: '2046-01' },
  earlyRepayments: [],
  createdAt: new Date('2026-10-16T10:00:00Z'),
  updatedAt: new Date('2026-10-16T11:00:00Z'),
};

describe('loan record mapping', () => {
  it('trims trailing zeros of numeric(7,4) rates', () => {
    expect(trimDecimal('3.5000')).toBe('3.5');
    expect(trimDecimal('0.0000')).toBe('0');
    expect(trimDecimal('12')).toBe('12');
    expect(trimDecimal('0.3450')).toBe('0.345');
  });

  it('maps a DB row to the wire record', () => {
    expect(toRecord(row)).toEqual({
      id: 7, name: 'Maison', kind: 'mortgage', isSimulation: false, sourceLoanId: null,
      currency: 'EUR', principal: '200000.00', startDate: '2026-02-05',
      annualRate: '3.5', insuranceRate: '0.345', insuranceBasis: 'remaining',
      insuranceAmount: null, fees: '1200.00',
      periods: [{ kind: 'partial_deferral', months: 12 }],
      finalPeriod: { solve: 'payment', endDate: '2046-01' },
      earlyRepayments: [],
      createdAt: '2026-10-16T10:00:00.000Z', updatedAt: '2026-10-16T11:00:00.000Z',
    });
  });

  it('keeps only engine fields in toTerms', () => {
    const terms = toTerms(toRecord(row));
    expect(Object.keys(terms).sort()).toEqual([
      'annualRate', 'earlyRepayments', 'fees', 'finalPeriod',
      'insuranceAmount', 'insuranceBasis', 'insuranceRate',
      'periods', 'principal', 'startDate',
    ]);
    expect(terms.insuranceAmount).toBeNull();
  });

  it('formats today as a local ISO date', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('maps insuranceAmount onto the insurance_monthly_amount column key', () => {
    const cols = toColumns({ name: 'Maison', insuranceAmount: '42.71' });
    expect(cols).toEqual({ name: 'Maison', insuranceMonthlyAmount: '42.71' });
    expect('insuranceAmount' in cols).toBe(false);
  });

  it('writes NULL when insuranceAmount is absent', () => {
    expect(toColumns({ name: 'Maison' }).insuranceMonthlyAmount).toBeNull();
    expect(toColumns({ insuranceAmount: null }).insuranceMonthlyAmount).toBeNull();
  });
});
