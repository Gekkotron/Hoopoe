// The .env.example SESSION_SECRET used to be a 50-char placeholder that
// passed the min(32) check, so a copied-as-is .env ran production with a
// world-known root key for TOTP, bank-sync, backup and MCP secrets. The
// schema now refuses known placeholders when NODE_ENV=production.
import { describe, it, expect } from 'vitest';
import { Env, isPlaceholderSessionSecret } from '../src/env.js';

const PLACEHOLDER = 'replace-me-with-at-least-32-random-characters-please';
const REAL = 'a3f1c9e07b2d48e6a1c5f0b7d93e2a4c6b8d0f1e3a5c7e9b2d4f6a8c0e1b3d5f';

function parse(extra: Record<string, string>) {
  return Env.safeParse({ DB_DRIVER: 'pglite', ...extra });
}

describe('SESSION_SECRET placeholder guard', () => {
  it('refuses the .env.example placeholder in production', () => {
    const res = parse({ NODE_ENV: 'production', SESSION_SECRET: PLACEHOLDER });
    expect(res.success).toBe(false);
    const issue = res.error!.issues.find((i) => i.path[0] === 'SESSION_SECRET');
    expect(issue?.message).toMatch(/openssl rand -hex 32/);
    expect(issue?.message).toMatch(/SESSION_SECRET_PREVIOUS/);
  });

  it('refuses edited replace-me variants in production', () => {
    expect(parse({ NODE_ENV: 'production', SESSION_SECRET: 'REPLACE_ME-0123456789abcdef0123456789' }).success)
      .toBe(false);
  });

  it('accepts a random secret in production', () => {
    expect(parse({ NODE_ENV: 'production', SESSION_SECRET: REAL }).success).toBe(true);
  });

  it('leaves development and test alone', () => {
    expect(parse({ NODE_ENV: 'development', SESSION_SECRET: PLACEHOLDER }).success).toBe(true);
    expect(parse({ NODE_ENV: 'test', SESSION_SECRET: PLACEHOLDER }).success).toBe(true);
  });

  it('does not flag hex secrets', () => {
    expect(isPlaceholderSessionSecret(REAL)).toBe(false);
  });

  it('treats an empty SESSION_SECRET_PREVIOUS as unset', () => {
    const res = parse({ NODE_ENV: 'production', SESSION_SECRET: REAL, SESSION_SECRET_PREVIOUS: '' });
    expect(res.success).toBe(true);
    expect(res.data!.SESSION_SECRET_PREVIOUS).toBeUndefined();
  });
});
