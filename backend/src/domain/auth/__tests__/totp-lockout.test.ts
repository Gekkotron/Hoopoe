import { describe, it, expect } from 'vitest';
import { TotpLockout } from '../totp-lockout.js';

describe('TotpLockout', () => {
  it('locks after the configured number of consecutive failures', () => {
    const l = new TotpLockout(3, 60_000);
    l.recordFailure(1, 0);
    l.recordFailure(1, 0);
    expect(l.remainingMs(1, 0)).toBe(0);
    l.recordFailure(1, 0);
    expect(l.remainingMs(1, 0)).toBe(60_000);
    expect(l.remainingMs(1, 59_999)).toBe(1);
    expect(l.remainingMs(1, 60_000)).toBe(0);
  });

  it('keeps accounts independent', () => {
    const l = new TotpLockout(1, 60_000);
    l.recordFailure(1, 0);
    expect(l.remainingMs(1, 0)).toBeGreaterThan(0);
    expect(l.remainingMs(2, 0)).toBe(0);
  });

  it('resets the count on success', () => {
    const l = new TotpLockout(2, 60_000);
    l.recordFailure(1, 0);
    l.recordSuccess(1);
    l.recordFailure(1, 0);
    expect(l.remainingMs(1, 0)).toBe(0);
  });

  it('starts a fresh count once a lock has run out', () => {
    const l = new TotpLockout(2, 1_000);
    l.recordFailure(1, 0);
    l.recordFailure(1, 0);
    expect(l.remainingMs(1, 500)).toBe(500);
    l.recordFailure(1, 2_000);
    expect(l.remainingMs(1, 2_000)).toBe(0);
  });
});
