import { describe, it, expect } from 'vitest';
import { isHopCount, parseTrustProxy } from '../trustProxy.js';

describe('parseTrustProxy', () => {
  it('is off when unset, empty or explicitly false', () => {
    for (const raw of [undefined, '', '  ', 'false', 'FALSE', '0']) {
      expect(parseTrustProxy(raw)).toBe(false);
    }
  });

  it('maps "true" to trust-everything', () => {
    expect(parseTrustProxy('true')).toBe(true);
  });

  it('refuses a bare hop count, which Fastify now fails closed', () => {
    expect(isHopCount('1')).toBe(true);
    expect(isHopCount(' 2 ')).toBe(true);
    expect(isHopCount('0')).toBe(false);
    expect(isHopCount('loopback')).toBe(false);
    expect(isHopCount(undefined)).toBe(false);
    expect(() => parseTrustProxy('1')).toThrow(/hop count/);
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
