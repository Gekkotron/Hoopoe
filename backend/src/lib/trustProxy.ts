// Parses TRUST_PROXY into the shape Fastify's `trustProxy` option takes.
// Fastify then derives `req.ip` (and so every rate-limit bucket) from
// X-Forwarded-For, walking back only through the hops this trusts.
//
//   unset / '' / 'false' / '0'  -> false: ignore X-Forwarded-For (desktop, dev)
//   'true'                      -> trust every hop (only behind a proxy that
//                                  overwrites the header, never on an open port)
//   '<n>'                       -> trust the n nearest hops
//   'a,b,c'                     -> trust these IPs / CIDRs / presets
//                                  (loopback, linklocal, uniquelocal)
export type TrustProxy = boolean | number | string[];

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
