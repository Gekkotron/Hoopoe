import { describe, it, expect } from 'vitest';
import {
  assertLaunchToken,
  decideLaunchRequest,
  LAUNCH_TOKEN_MISSING_ERROR,
} from '../launchToken.js';

const TOKEN = 'a'.repeat(64);

describe('assertLaunchToken', () => {
  it('refuses a missing, empty or short token', () => {
    for (const v of [undefined, '', 'short']) {
      expect(() => assertLaunchToken(v)).toThrow(LAUNCH_TOKEN_MISSING_ERROR);
    }
  });

  it('returns a long enough token', () => {
    expect(assertLaunchToken(TOKEN)).toBe(TOKEN);
  });
});

describe('decideLaunchRequest', () => {
  it('denies requests without the cookie', () => {
    expect(decideLaunchRequest('GET', '/', undefined, TOKEN)).toEqual({ action: 'deny' });
    expect(decideLaunchRequest('GET', '/api/accounts', 'hoopoe_launch=nope', TOKEN)).toEqual({ action: 'deny' });
  });

  it('allows requests with the cookie among others', () => {
    expect(decideLaunchRequest('GET', '/api/x', `a=1; hoopoe_launch=${TOKEN}; b=2`, TOKEN)).toEqual({ action: 'allow' });
  });

  it('exempts only /api/mcp and its sub-routes', () => {
    expect(decideLaunchRequest('POST', '/api/mcp/rpc', undefined, TOKEN)).toEqual({ action: 'allow' });
    expect(decideLaunchRequest('POST', '/api/mcp', undefined, TOKEN)).toEqual({ action: 'allow' });
    expect(decideLaunchRequest('GET', '/api/mcpx', undefined, TOKEN)).toEqual({ action: 'deny' });
    expect(decideLaunchRequest('GET', '/api/settings/mcp', undefined, TOKEN)).toEqual({ action: 'deny' });
  });

  it('exchanges the right token for a strict session cookie and redirects to /', () => {
    const d = decideLaunchRequest('GET', `/__launch?token=${TOKEN}`, undefined, TOKEN);
    expect(d.action).toBe('redirect');
    if (d.action !== 'redirect') return;
    expect(d.location).toBe('/');
    expect(d.setCookie).toContain(`hoopoe_launch=${TOKEN}`);
    expect(d.setCookie).toContain('HttpOnly');
    expect(d.setCookie).toContain('SameSite=Strict');
    expect(d.setCookie).toContain('Path=/');
    expect(d.setCookie).not.toMatch(/Max-Age|Expires|Secure/i);
  });

  it('denies a wrong, missing or non-GET launch exchange', () => {
    expect(decideLaunchRequest('GET', '/__launch?token=wrong', undefined, TOKEN)).toEqual({ action: 'deny' });
    expect(decideLaunchRequest('GET', '/__launch', undefined, TOKEN)).toEqual({ action: 'deny' });
    expect(decideLaunchRequest('POST', `/__launch?token=${TOKEN}`, undefined, TOKEN)).toEqual({ action: 'deny' });
  });
});
