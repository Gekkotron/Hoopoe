import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BackupProviderError, DestinationNotAllowedError } from './errors.js';

// Network policy for remote backup destinations (WebDAV, FTP). Loopback,
// link-local (incl. the 169.254.169.254 cloud metadata endpoint) and
// unspecified addresses are refused so a destination cannot be used to probe
// services on the Hoopoe host itself. RFC1918 / ULA private LAN addresses
// stay allowed: a NAS on the LAN is the common target.

const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); // unspecified / "this network"
blocked.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local, cloud metadata
blocked.addAddress('::', 'ipv6'); // unspecified
blocked.addAddress('::1', 'ipv6'); // loopback
blocked.addSubnet('fe80::', 10, 'ipv6'); // link-local

// Expands an IPv6 literal to its 8 16-bit groups (handles "::" and a dotted
// IPv4 tail). Returns null when it is not a well-formed address.
function v6Groups(ip: string): number[] | null {
  let s = ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted) {
    const o = dotted.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    s =
      s.slice(0, dotted.index) +
      `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const fill = Array<string>(halves.length === 2 ? missing : 0).fill('0');
  const groups = [...head, ...fill, ...tail].map((p) => parseInt(p, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

// IPv4 address embedded in an IPv6 form that routes to it: IPv4-mapped
// (::ffff:a.b.c.d), deprecated IPv4-compatible (::a.b.c.d) and NAT64
// (64:ff9b::/96).
function embeddedV4(groups: number[]): string | null {
  const [a, b, c, d, e, f, g, h] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  const lowZero = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  const nat64 = a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0;
  if ((lowZero && (f === 0xffff || f === 0)) || nat64) {
    return `${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  let ip = address.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const groups = v6Groups(ip);
    if (!groups) return true; // unparseable: fail closed
    const v4 = embeddedV4(groups);
    if (v4) return blocked.check(v4, 'ipv4') || blocked.check(ip, 'ipv6');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: fail closed
}

// Test seams. Never active outside NODE_ENV=test: the setters refuse, and the
// bypass is ignored if NODE_ENV changes.
let testLookup: typeof dnsLookup | null = null;
let testBypass = false;

function assertTestEnv(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('net-guard test seams are only available when NODE_ENV=test');
  }
}

export function __setLookupForTests(fn: typeof dnsLookup | null): void {
  assertTestEnv();
  testLookup = fn;
}

export function __setNetGuardBypassForTests(on: boolean): void {
  assertTestEnv();
  testBypass = on;
}

const NOT_ALLOWED_MSG =
  'destination address is not allowed (loopback, link-local and unspecified addresses are refused)';

// Resolves `host` and returns the vetted addresses. Refuses when ANY resolved
// address is blocked. Callers connect to a returned address (FTP) or re-run
// this right before every request (WebDAV) to narrow the DNS rebinding window.
export async function resolveAllowedAddresses(host: string): Promise<string[]> {
  let h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (testBypass && process.env.NODE_ENV === 'test') return [h];
  if (isIP(h.split('%')[0]!)) {
    if (isBlockedAddress(h)) throw new DestinationNotAllowedError(NOT_ALLOWED_MSG);
    return [h];
  }
  let addrs: { address: string }[];
  try {
    addrs = await (testLookup ?? dnsLookup)(h, { all: true });
  } catch (err) {
    throw new BackupProviderError(
      `dns lookup failed for ${h}: ${err instanceof Error ? err.message : String(err)}`,
      'connection failed',
    );
  }
  if (addrs.length === 0) {
    throw new BackupProviderError(`dns lookup returned no address for ${h}`, 'connection failed');
  }
  if (addrs.some((a) => isBlockedAddress(a.address))) {
    throw new DestinationNotAllowedError(NOT_ALLOWED_MSG);
  }
  return addrs.map((a) => a.address);
}

// CR, LF and NUL in a value that ends up inside an FTP command or an HTTP
// header would let it smuggle extra commands.
export function hasControlChars(value: string): boolean {
  return /[\r\n\0]/.test(value);
}
