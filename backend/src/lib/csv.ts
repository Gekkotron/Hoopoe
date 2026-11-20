// Cell helpers for the semicolon-separated (Excel-FR) CSV export.

// Characters that make a spreadsheet evaluate a cell as a formula when they
// open it (OWASP "CSV injection"). Tab and CR are included because some
// apps strip them and then see the next character.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

// Text cell: neutralize a leading formula trigger with an apostrophe, which
// spreadsheets treat as "this is text" and hide, then quote per RFC 4180
// with ';' added to the trigger set since it is the separator. Use for every
// free-text column (labels, notes, names) — never for amounts, whose leading
// '-' must stay a number.
export function csvText(value: string): string {
  const safe = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  if (/[;"\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

// "-42.30" → "-42,30" — comma decimals so Excel-FR reads the column as a
// number instead of a date-ish string.
export function csvAmount(amount: string): string {
  return amount.replace('.', ',');
}
