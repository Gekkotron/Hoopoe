import { describe, it, expect } from 'vitest';
import { isLoopbackHost } from '../loopbackHost.js';
import { assertServerAuthMode } from '../../entry/serverAuthMode.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1:1234', '127.0.0.1', 'localhost', 'localhost:80', 'LOCALHOST:5', '[::1]:9', '[::1]'])(
    'accepts %s', (h) => expect(isLoopbackHost(h)).toBe(true),
  );
  it.each([
    'evil.example', '127.0.0.1.evil.example', 'localhost.evil.example', '192.168.1.10:8001',
    '0.0.0.0:80', '127.0.0.1@evil.example', '127.0.0.1:abc', '[::1', '[::2]:1', '',
  ])('rejects %s', (h) => expect(isLoopbackHost(h)).toBe(false));
  it('rejects a missing header', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe('assertServerAuthMode', () => {
  it('refuses none', () => {
    expect(() => assertServerAuthMode('none')).toThrow(/only supported by the desktop sidecar/);
  });
  it('accepts session', () => {
    expect(() => assertServerAuthMode('session')).not.toThrow();
  });
});
