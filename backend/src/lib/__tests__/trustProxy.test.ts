import { describe, it, expect } from 'vitest';
import { parseTrustProxy } from '../trustProxy.js';

describe('parseTrustProxy', () => {
  it('is off when unset, empty or explicitly false', () => {
    for (const raw of [undefined, '', '  ', 'false', 'FALSE', '0']) {
      expect(parseTrustProxy(raw)).toBe(false);
    }
  });

  it('maps "true" to trust-everything', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('reads a bare positive integer as a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
  });

  it('splits a comma list of addresses, CIDRs and presets', () => {
    expect(parseTrustProxy('loopback, uniquelocal,10.0.0.0/8')).toEqual([
      'loopback', 'uniquelocal', '10.0.0.0/8',
    ]);
  });

  it('drops empty list entries', () => {
    expect(parseTrustProxy('loopback,,')).toEqual(['loopback']);
  });
});
