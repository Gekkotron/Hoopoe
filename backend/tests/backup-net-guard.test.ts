import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isBlockedAddress,
  resolveAllowedAddresses,
  hasControlChars,
  __setLookupForTests,
  __setNetGuardBypassForTests,
} from '../src/domain/backup/net-guard.js';
import { DestinationNotAllowedError } from '../src/domain/backup/errors.js';

type Lookup = Parameters<typeof __setLookupForTests>[0];
const lookupTo = (...addresses: string[]): Lookup =>
  (async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) as unknown as Lookup;

beforeEach(() => __setNetGuardBypassForTests(false));
afterEach(() => {
  __setLookupForTests(null);
  __setNetGuardBypassForTests(true); // restore the suite-wide default from tests/setup.ts
});

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'febf::1',
    'fe80::1%eth0',
    '[::1]',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:0.0.0.0',
    '0:0:0:0:0:ffff:7f00:0001',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.20',
    '8.8.8.8',
    '169.253.1.1',
    '128.0.0.1',
    'fd00::1234',
    'fc00::1',
    '2001:4860:4860::8888',
    'fec0::1',
    '::ffff:192.168.1.20',
    '::ffff:c0a8:0114',
  ])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('resolveAllowedAddresses', () => {
  it('refuses IP literals that are blocked, without any lookup', async () => {
    await expect(resolveAllowedAddresses('169.254.169.254')).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
    await expect(resolveAllowedAddresses('[::1]')).rejects.toBeInstanceOf(DestinationNotAllowedError);
  });

  it('returns a private LAN literal as-is', async () => {
    await expect(resolveAllowedAddresses('192.168.1.20')).resolves.toEqual(['192.168.1.20']);
  });

  it('refuses a hostname that resolves to 127.0.0.1', async () => {
    __setLookupForTests(lookupTo('127.0.0.1'));
    await expect(resolveAllowedAddresses('evil.example')).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
  });

  it('refuses when ANY resolved address is blocked', async () => {
    __setLookupForTests(lookupTo('192.168.1.20', '169.254.169.254'));
    await expect(resolveAllowedAddresses('rebind.example')).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
  });

  it('refuses a name that resolves to an IPv4-mapped loopback', async () => {
    __setLookupForTests(lookupTo('::ffff:127.0.0.1'));
    await expect(resolveAllowedAddresses('mapped.example')).rejects.toBeInstanceOf(
      DestinationNotAllowedError,
    );
  });

  it('returns every vetted address of an allowed hostname', async () => {
    __setLookupForTests(lookupTo('192.168.1.20', 'fd00::5'));
    await expect(resolveAllowedAddresses('nas.example')).resolves.toEqual(['192.168.1.20', 'fd00::5']);
  });

  it('refuses localhost through the real resolver', async () => {
    await expect(resolveAllowedAddresses('localhost')).rejects.toBeInstanceOf(DestinationNotAllowedError);
  });

  it('a lookup failure is a connection failure, not a policy refusal', async () => {
    __setLookupForTests((async () => {
      throw new Error('getaddrinfo ENOTFOUND nope.invalid');
    }) as unknown as Lookup);
    const err = await resolveAllowedAddresses('nope.invalid').catch((e) => e);
    expect(err).not.toBeInstanceOf(DestinationNotAllowedError);
    expect(err.category).toBe('connection failed');
  });

  it('the bypass setter is refused outside NODE_ENV=test', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => __setNetGuardBypassForTests(true)).toThrow(/NODE_ENV=test/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('hasControlChars', () => {
  it('flags CR, LF and NUL only', () => {
    expect(hasControlChars('a\rb')).toBe(true);
    expect(hasControlChars('a\nb')).toBe(true);
    expect(hasControlChars('a\0b')).toBe(true);
    expect(hasControlChars('plain user-1')).toBe(false);
  });
});
