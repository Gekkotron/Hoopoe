import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../../env.js';
import {
  masterKey, unwrapKey, decryptEnvelope, encryptEnvelope, envelopeAad,
} from '../../../domain/mcp/crypto.js';
import { getMcpByUsername } from '../../../domain/mcp/store.js';
import { buildOp, UnknownOpError } from './ops.js';

const Envelope = z.object({
  user: z.string().min(1),
  v: z.literal(1),
  nonce: z.string().min(1),
  ct: z.string().min(1),
});
const Inner = z.object({
  op: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  ts: z.number(),
});
const SKEW_MS = 120_000;

// Every authentication failure gets the same body: telling "unknown user /
// MCP off" apart from "bad key" or "stale" let anyone list which usernames
// have MCP enabled.
const AUTH_FAILED = { error: 'authentication failed' } as const;

// Envelopes already accepted, keyed `user|nonce`, kept for the whole window
// in which their timestamp would still pass (±SKEW_MS). A captured request
// replayed inside that window is refused. In memory: one process, and a
// restart only re-opens a window that closes within SKEW_MS anyway.
// Recorded only after decryption succeeds, so unauthenticated callers
// cannot fill it.
function createReplayGuard(ttlMs: number) {
  const seen = new Map<string, number>(); // key -> expiry
  return (key: string, now = Date.now()): boolean => {
    for (const [k, exp] of seen) {
      if (exp > now) break; // insertion order ~ expiry order
      seen.delete(k);
    }
    if (seen.has(key)) return false;
    seen.set(key, now + ttlMs);
    return true;
  };
}

export async function mcpRpcRoutes(app: FastifyInstance): Promise<void> {
  const firstUse = createReplayGuard(2 * SKEW_MS);

  // Public route — it performs its own crypto auth. Dedicated rate limit.
  app.post('/api/mcp/rpc', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const env0 = Envelope.safeParse(req.body);
    if (!env0.success) return reply.code(400).send({ error: 'invalid envelope' });
    const { user, nonce, ct } = env0.data;

    const mcp = await getMcpByUsername(user);
    if (!mcp || !mcp.enabled || !mcp.keyWrapped) {
      return reply.code(401).send(AUTH_FAILED);
    }

    let key: Buffer;
    let inner: z.infer<typeof Inner>;
    try {
      key = unwrapKey(masterKey(env.SESSION_SECRET), mcp.keyWrapped);
      const plaintext = decryptEnvelope(key, envelopeAad(user, 'req'), nonce, ct);
      const parsed = Inner.safeParse(JSON.parse(plaintext));
      if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
      inner = parsed.data;
    } catch {
      // Tag failure / wrong key / malformed ciphertext — do not distinguish.
      return reply.code(401).send(AUTH_FAILED);
    }

    if (Math.abs(Date.now() - inner.ts) > SKEW_MS) {
      return reply.code(401).send(AUTH_FAILED);
    }
    if (!firstUse(`${user}|${nonce}`)) {
      return reply.code(401).send(AUTH_FAILED);
    }

    // From here, respond ENCRYPTED — including operation-level errors.
    const respond = (status: number, body: unknown) => {
      const out = encryptEnvelope(key, envelopeAad(user, 'res'), JSON.stringify({ status, body }));
      return reply.code(200).send({ v: 1, nonce: out.nonce, ct: out.ct });
    };

    let built;
    try {
      built = buildOp(inner.op, inner.args);
    } catch (err) {
      if (err instanceof UnknownOpError) return respond(400, { error: err.message });
      throw err;
    }

    const sub = await app.inject({
      method: built.method,
      url: built.url,
      query: built.query,
      payload: built.payload as string | object | Buffer | undefined,
      headers: {
        'x-hoopoe-internal-auth': app.internalAuthSecret,
        'x-hoopoe-internal-uid': String(mcp.userId),
        ...(built.payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    });

    let body: unknown;
    try { body = sub.json(); } catch { body = sub.body; }
    return respond(sub.statusCode, body);
  });
}
