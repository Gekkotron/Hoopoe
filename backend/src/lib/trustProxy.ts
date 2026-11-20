// Parses TRUST_PROXY into the shape Fastify's `trustProxy` option takes.
// Fastify then derives `req.ip` (and so every rate-limit bucket) from
// X-Forwarded-For, walking back only through the hops this trusts.
//
//   unset / '' / 'false' / '0'  -> false: ignore X-Forwarded-For (desktop, dev)
//   'true'                      -> trust every hop (only behind a proxy that
//                                  overwrites the header, never on an open port)
//   'a,b,c'                     -> trust these IPs / CIDRs / presets
//                                  (loopback, linklocal, uniquelocal)
//
// A bare hop count ('1', '2', ...) used to be accepted. Fastify >= 5.12
// fails it closed (it trusts nothing, because a hop count cannot check the
// immediate peer), so it would silently turn per-client rate limits back
// into one shared bucket. env.ts refuses it at boot instead, see
// isHopCount().
export type TrustProxy = boolean | string[];

export function isHopCount(raw: string | undefined): boolean {
  return /^[1-9]\d*$/.test(raw?.trim() ?? '');
}

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = raw?.trim() ?? '';
  if (value === '' || value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true') return true;
  if (isHopCount(value)) throw new Error('TRUST_PROXY hop counts are not supported');
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}
