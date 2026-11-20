import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

// Shared zod schema for `:id` path params. Coerced from string because Fastify
// hands us params as strings.
export const IdParam = z.object({ id: z.coerce.number().int().positive() });

// Extract and validate `:id` from Fastify's route params, replying 400 and
// returning null on invalid input. Callers must return immediately when null.
export function parseId(req: FastifyRequest, reply: FastifyReply): number | null {
  const r = IdParam.safeParse(req.params);
  if (!r.success) {
    reply.code(400).send({ error: 'invalid id' });
    return null;
  }
  return r.data.id;
}

// The Postgres driver error behind `err` (anything with a string `.code`),
// or undefined. Used to tell 23505 (unique_violation), 23503
// (foreign_key_violation), … apart from generic exceptions without pulling
// the whole `pg` type surface.
//
// drizzle-orm >= 0.44 wraps every failed query in a DrizzleQueryError
// ("Failed query: …", no `code`) and keeps the driver error on `.cause`, so
// the SQLSTATE and the server's message live one level down. Walk the
// (short) cause chain instead of reading `err.code` directly.
export function pgError(err: unknown): { code: string; message?: string } | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && typeof cur === 'object' && cur !== null; depth++) {
    if (typeof (cur as { code?: unknown }).code === 'string') {
      return cur as { code: string; message?: string };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

// Structured HTTP-status-carrying error. Route handlers can `throw new
// HttpError(404, 'not found')` and the global setErrorHandler maps it to the
// wire response — no need to thread `reply` through every helper.
export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly extra?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
  }
}
