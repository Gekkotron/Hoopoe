import { describe, it, expect } from 'vitest';
import { CreateEventBody, CreateGoalBody } from '../src/http/routes/goals/schemas.js';

describe('goal zod schemas', () => {
  it('rejects amounts that overflow numeric(14,2)', () => {
    const goal = { accountId: 1, name: 'Vacances' };
    expect(CreateGoalBody.safeParse({ ...goal, targetAmount: '999999999999.99' }).success).toBe(true);
    expect(CreateGoalBody.safeParse({ ...goal, targetAmount: '1000000000000' }).success).toBe(false);
    const ev = { eventDate: '2026-01-01' };
    expect(CreateEventBody.safeParse({ ...ev, amount: '-999999999999.99' }).success).toBe(true);
    expect(CreateEventBody.safeParse({ ...ev, amount: '-1000000000000' }).success).toBe(false);
  });
});
