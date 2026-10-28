import type { NotificationPayload } from './types.js';

type Privacy = { hideAmount: boolean; hideMerchant: boolean };

const amount = (n: number) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Enrichment happens in emit.ts; the fallback keeps legacy rows readable.
// Explicit +/− so a credit never reads like a spend; U+2212 for the minus.
const signed = (n: number, dir: Direction) => `${dir === 'credit' ? '+' : '−'}${amount(Math.abs(n))}`;

type Direction = 'debit' | 'credit';
type BigTx = Extract<NotificationPayload, { kind: 'big_transaction' }>;
// `single.amount` is signed; `summary.direction` is absent on legacy rows.
const directionOf = (p: BigTx): Direction | undefined =>
  'single' in p ? (p.single.amount < 0 ? 'debit' : 'credit') : p.summary.direction;

const accountLabel  = (id: number, name?: string) => name ?? `account #${id}`;
const categoryLabel = (id: number, name?: string) => name ?? `category #${id}`;

export function renderTitle(p: NotificationPayload, _priv: Privacy): string {
  switch (p.kind) {
    case 'big_transaction': {
      const dir = directionOf(p);
      return dir ? `Big ${dir}` : 'Big transaction';
    }
    case 'account_low':          return 'Account balance low';
    case 'envelope_exceeded':    return 'Budget exceeded';
    case 'bank_sync_failed':     return 'Bank sync failed';
    case 'test':                 return 'Test notification';
  }
}

export function renderBody(p: NotificationPayload, priv: Privacy): string {
  switch (p.kind) {
    case 'big_transaction': {
      if ('summary' in p) {
        const dir   = p.summary.direction;
        const total = priv.hideAmount ? '' : ` (${dir ? signed(p.summary.total, dir) : amount(p.summary.total)})`;
        const acct  = accountLabel(p.summary.accountId, p.summary.accountName);
        const noun  = `${dir ?? 'transaction'}${p.summary.count === 1 ? '' : 's'}`;
        return `${p.summary.count} big ${noun} on ${acct}${total}`;
      }
      const merchant = !priv.hideMerchant && p.single.merchant ? ` at ${p.single.merchant}` : '';
      const money    = priv.hideAmount ? '' : `${signed(p.single.amount, directionOf(p)!)} `;
      const acct     = accountLabel(p.single.accountId, p.single.accountName);
      return `${money}on ${acct}${merchant}`.trim() || 'A big transaction was recorded';
    }
    case 'account_low': {
      const balance = priv.hideAmount ? '' : ` (${amount(p.balance)})`;
      const acct    = accountLabel(p.accountId, p.accountName);
      return `${acct} dipped below its floor${balance}`;
    }
    case 'envelope_exceeded': {
      const money = priv.hideAmount ? '' : ` — ${amount(p.spent)} of ${amount(p.envelope)}`;
      const cat   = categoryLabel(p.categoryId, p.categoryName);
      return `${cat} over budget for ${p.month}${money}`;
    }
    case 'bank_sync_failed':
      return `Sync failed for ${accountLabel(p.accountId, p.accountName)}: ${p.reason}`;
    case 'test':
      return 'This is a test — if you see it, the pipeline works.';
  }
}

export function renderFullDetail(p: NotificationPayload): { title: string; body: string } {
  return {
    title: renderTitle(p, { hideAmount: false, hideMerchant: false }),
    body:  renderBody (p, { hideAmount: false, hideMerchant: false }),
  };
}
