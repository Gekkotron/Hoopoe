import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { buildAmountRange, pgError, parseId } from '../src/http/routes/transactions/helpers.js';

describe('pgError', () => {
  it('returns the error for objects with a string `code` field (pg-flavored errors)', () => {
    expect(pgError({ code: '23505' })?.code).toBe('23505');
    expect(pgError({ code: '23503', detail: 'fk violation' })?.code).toBe('23503');
  });

  it('returns the driver error from a DrizzleQueryError-style `.cause`', () => {
    const driver = Object.assign(new Error('violates check'), { code: '23514' });
    const wrapped = new Error('Failed query: update …', { cause: driver });
    expect(pgError(wrapped)?.code).toBe('23514');
    expect(pgError(wrapped)?.message).toBe('violates check');
  });

  it('returns undefined for values that lack a string code', () => {
    expect(pgError(null)).toBeUndefined();
    expect(pgError(undefined)).toBeUndefined();
    expect(pgError('boom')).toBeUndefined();
    expect(pgError({})).toBeUndefined();
    expect(pgError({ code: 42 })).toBeUndefined();  // wrong type
    expect(pgError(new Error('x'))).toBeUndefined(); // Error has no code
  });
});

describe('parseId', () => {
  function makeReply() {
    const codeFn = vi.fn().mockReturnThis();
    const sendFn = vi.fn().mockReturnThis();
    return { code: codeFn, send: sendFn } as unknown as FastifyReply & {
      code: typeof codeFn;
      send: typeof sendFn;
    };
  }

  it('returns the parsed integer for a valid string param', () => {
    const req = { params: { id: '42' } } as unknown as FastifyRequest;
    const reply = makeReply();
    expect(parseId(req, reply)).toBe(42);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('returns null and replies 400 for a non-numeric id', () => {
    const req = { params: { id: 'not-a-number' } } as unknown as FastifyRequest;
    const reply = makeReply();
    expect(parseId(req, reply)).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'invalid id' });
  });

  it('rejects zero and negative ids (positive constraint)', () => {
    for (const bad of ['0', '-1', '-9999']) {
      const req = { params: { id: bad } } as unknown as FastifyRequest;
      const reply = makeReply();
      expect(parseId(req, reply)).toBeNull();
      expect(reply.code).toHaveBeenCalledWith(400);
    }
  });

  it('rejects a fractional id', () => {
    const req = { params: { id: '3.14' } } as unknown as FastifyRequest;
    const reply = makeReply();
    expect(parseId(req, reply)).toBeNull();
    expect(reply.code).toHaveBeenCalledWith(400);
  });
});

describe('buildAmountRange', () => {
  it('widens an integer needle to [N.00, N.99]', () => {
    expect(buildAmountRange('19')).toEqual({ lo: '19.00', hi: '19.99' });
  });

  it('widens a one-decimal needle to [N.d0, N.d9]', () => {
    expect(buildAmountRange('55.5')).toEqual({ lo: '55.50', hi: '55.59' });
  });

  it('leaves a full two-decimal needle unchanged (exact match)', () => {
    expect(buildAmountRange('19.72')).toEqual({ lo: '19.72', hi: '19.72' });
  });

  it('preserves multi-digit integer parts', () => {
    expect(buildAmountRange('338')).toEqual({ lo: '338.00', hi: '338.99' });
    expect(buildAmountRange('1234.5')).toEqual({ lo: '1234.50', hi: '1234.59' });
  });

  it('handles zero cleanly', () => {
    expect(buildAmountRange('0')).toEqual({ lo: '0.00', hi: '0.99' });
    expect(buildAmountRange('0.5')).toEqual({ lo: '0.50', hi: '0.59' });
  });
});
