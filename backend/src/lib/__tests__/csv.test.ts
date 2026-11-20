import { describe, it, expect } from 'vitest';
import { csvAmount, csvText } from '../csv.js';

describe('csvText', () => {
  it('passes plain text through', () => {
    expect(csvText('CARTE 12/03 BOULANGERIE')).toBe('CARTE 12/03 BOULANGERIE');
    expect(csvText('')).toBe('');
  });

  it('quotes per RFC 4180 with ; as the separator', () => {
    expect(csvText('a;b')).toBe('"a;b"');
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    expect(csvText('line\nbreak')).toBe('"line\nbreak"');
  });

  // Bank labels and notes are attacker-influenced (a transfer reference is
  // free text). A cell starting with one of these is run as a formula by
  // Excel / LibreOffice / Sheets.
  it.each(['=', '+', '-', '@', '\t', '\r'])('neutralizes a leading %j', (c) => {
    const out = csvText(`${c}HYPERLINK("http://x","y")`);
    expect(out.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('still quotes after neutralizing', () => {
    expect(csvText('=1;2')).toBe(`"'=1;2"`);
    expect(csvText('=cmd|"/c calc"!A0')).toBe(`"'=cmd|""/c calc""!A0"`);
  });

  it('leaves a trigger character alone when it is not leading', () => {
    expect(csvText('VIR SEPA -REF 42')).toBe('VIR SEPA -REF 42');
  });
});

describe('csvAmount', () => {
  it('uses a comma decimal and keeps the sign (never neutralized)', () => {
    expect(csvAmount('-42.30')).toBe('-42,30');
    expect(csvAmount('1250.00')).toBe('1250,00');
  });
});
