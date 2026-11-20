import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchOf } from '../zodPatch.js';

describe('patchOf', () => {
  const Create = z.object({
    name: z.string().min(1),
    priority: z.number().int().default(0),
    enabled: z.boolean().default(true),
  });
  const Patch = patchOf(Create);

  it('leaves omitted defaulted fields undefined', () => {
    expect(Patch.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(Patch.parse({})).toEqual({});
  });

  it('still validates fields that are present', () => {
    expect(Patch.parse({ priority: 42 })).toEqual({ priority: 42 });
    expect(Patch.safeParse({ priority: 1.5 }).success).toBe(false);
    expect(Patch.safeParse({ name: '' }).success).toBe(false);
  });

  it('does not change the create schema', () => {
    expect(Create.parse({ name: 'x' })).toEqual({ name: 'x', priority: 0, enabled: true });
  });
});
