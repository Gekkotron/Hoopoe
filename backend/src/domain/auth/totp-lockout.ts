// Per-account lockout for the second factor. The per-IP rate limit alone
// lets someone who has the password rotate addresses (or, before
// TRUST_PROXY, share the nginx bucket with everyone) and keep guessing
// 6-digit codes. After MAX_FAILURES consecutive wrong codes the account's
// 2FA verify is refused for LOCK_MS, whatever the client address.
//
// In memory on purpose: one backend process, and a restart clearing it is
// fine (the attacker would still need the password to get back here).
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;

type Entry = { failures: number; lockedUntil: number };

export class TotpLockout {
  private readonly entries = new Map<number, Entry>();

  constructor(
    private readonly maxFailures = MAX_FAILURES,
    private readonly lockMs = LOCK_MS,
  ) {}

  /** Milliseconds left on the lock, or 0 when the account may try. */
  remainingMs(userId: number, now = Date.now()): number {
    const e = this.entries.get(userId);
    if (!e || e.lockedUntil <= now) return 0;
    return e.lockedUntil - now;
  }

  recordFailure(userId: number, now = Date.now()): void {
    const e = this.entries.get(userId) ?? { failures: 0, lockedUntil: 0 };
    // A lock that has run out starts a fresh count.
    if (e.lockedUntil !== 0 && e.lockedUntil <= now) {
      e.failures = 0;
      e.lockedUntil = 0;
    }
    e.failures += 1;
    if (e.failures >= this.maxFailures) e.lockedUntil = now + this.lockMs;
    this.entries.set(userId, e);
  }

  recordSuccess(userId: number): void {
    this.entries.delete(userId);
  }
}
