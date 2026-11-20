// Per-launch token between the desktop shell and its sidecar. The Rust shell
// generates a random token for every launch, hands it to the sidecar through
// HOOPOE_LAUNCH_TOKEN and opens the WebView at /__launch?token=<token>. The
// sidecar answers that one request with a session cookie; every other request
// must carry the cookie. Another local process or OS user can reach the
// loopback port but does not know the token, so it gets 403 instead of the
// AUTH_MODE=none "everyone is the local user" API.
//
// Pure decision logic lives here so the Fastify app (buildServer.ts) and the
// dependency-free unlock server (entry/unlockServer.ts) enforce the same rule.
import { createHash, timingSafeEqual } from 'node:crypto';

export const LAUNCH_TOKEN_ENV = 'HOOPOE_LAUNCH_TOKEN';
export const LAUNCH_PATH = '/__launch';
export const LAUNCH_COOKIE = 'hoopoe_launch';
const MIN_TOKEN_LENGTH = 32;

export const LAUNCH_TOKEN_MISSING_ERROR =
  `${LAUNCH_TOKEN_ENV} is required by the desktop sidecar (the Tauri shell sets it on every launch). ` +
  `When running the entry by hand, export ${LAUNCH_TOKEN_ENV} with at least ${MIN_TOKEN_LENGTH} characters ` +
  `and open /__launch?token=<token> in the browser once.`;

// Returns the token, or throws when the desktop entry must not boot.
export function assertLaunchToken(value: string | undefined): string {
  if (!value || value.length < MIN_TOKEN_LENGTH) throw new Error(LAUNCH_TOKEN_MISSING_ERROR);
  return value;
}

// Hash both sides so timingSafeEqual always sees equal-length buffers and the
// length of the real token is not observable.
function tokensMatch(candidate: string, token: string): boolean {
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// /api/mcp and its sub-routes carry their own HMAC envelope auth, and the MCP
// bridge (a separate process) has no cookie jar.
function isExempt(pathname: string): boolean {
  return pathname === '/api/mcp' || pathname.startsWith('/api/mcp/');
}

export type LaunchDecision =
  | { action: 'allow' }
  | { action: 'redirect'; location: string; setCookie: string }
  | { action: 'deny' };

export function decideLaunchRequest(
  method: string,
  rawUrl: string,
  cookieHeader: string | undefined,
  token: string,
): LaunchDecision {
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

  if (pathname === LAUNCH_PATH) {
    if (method !== 'GET') return { action: 'deny' };
    const candidate = new URLSearchParams(qIdx === -1 ? '' : rawUrl.slice(qIdx + 1)).get('token');
    if (candidate === null || !tokensMatch(candidate, token)) return { action: 'deny' };
    return {
      action: 'redirect',
      location: '/',
      // Session cookie (no Max-Age), not Secure: the WebView talks plain http
      // to 127.0.0.1.
      setCookie: `${LAUNCH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`,
    };
  }

  if (isExempt(pathname)) return { action: 'allow' };

  const cookie = readCookie(cookieHeader, LAUNCH_COOKIE);
  if (cookie !== undefined && tokensMatch(cookie, token)) return { action: 'allow' };
  return { action: 'deny' };
}
