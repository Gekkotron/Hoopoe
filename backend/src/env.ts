import { z } from 'zod';
import { parseTrustProxy } from './lib/trustProxy.js';

const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

// SESSION_SECRET values that shipped in public files (.env.example). Any
// install running one in production has a world-known root key for TOTP,
// bank-sync, backup and MCP secrets, so boot is refused (see the refine
// below). `replace-me` catches edited-but-not-replaced variants.
export const SESSION_SECRET_PLACEHOLDERS: readonly string[] = [
  'replace-me-with-at-least-32-random-characters-please',
];

export function isPlaceholderSessionSecret(secret: string): boolean {
  return SESSION_SECRET_PLACEHOLDERS.includes(secret) || /replace[-_ ]?me/i.test(secret);
}

// Compose passes unset optional vars as '' — treat that as absent.
const emptyAsUndefined = (v: unknown) => (v === '' ? undefined : v);

export const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    // Selects the SQL backend. `postgres` (default) drives a real Postgres via
    // pg.Pool + drizzle-orm/node-postgres. `pglite` drives an embedded
    // Postgres-in-WASM via @electric-sql/pglite + drizzle-orm/pglite — used
    // for the Tauri desktop distribution and for a docker-free test path.
    DB_DRIVER: z.enum(['postgres', 'pglite']).default('postgres'),
    // Selects the auth model. `session` (default) is the LAN/Docker path:
    // cookie + @fastify/session + argon2id passwords, users register through
    // `/api/onboarding/create`. `none` is the Tauri desktop path: no cookies,
    // no login round-trip — every request is authenticated as a single
    // hard-coded local user seeded on first boot. Never enable `none` on a
    // deployment that isn't strictly loopback-only.
    AUTH_MODE: z.enum(['session', 'none']).default('session'),
    // Required only for `postgres`. For `pglite` we default to an in-memory
    // DB unless PGLITE_PATH is set (then a filesystem-backed PGlite is used).
    DATABASE_URL: z.string().url().optional(),
    PGLITE_PATH: z.string().optional(),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    // Set for ONE boot when changing SESSION_SECRET: the Docker entry
    // re-encrypts every secret derived from it (TOTP, bank-sync, backup
    // destinations, MCP keys) from this old value to the new one, in a
    // single transaction, then logs that it can be removed.
    SESSION_SECRET_PREVIOUS: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    // Optional bearer token for /metrics. When set, the endpoint requires
    // `Authorization: Bearer <token>` and rejects everything else with 401.
    // When empty, the endpoint stays open — a startup warning is logged so
    // operators know to configure it before exposing the app beyond the LAN.
    // Prometheus scrapers can pass the token via `bearer_token`/`bearer_token_file`.
    METRICS_TOKEN: z.preprocess(emptyAsUndefined, z.string().min(16).optional()),
    // /metrics is only served when METRICS_TOKEN is set. With no token it is
    // disabled (404) unless this is true, which restores the old open
    // endpoint for LAN-only scrape targets. Ignored when a token is set.
    METRICS_PUBLIC: boolish.default(false),
    // Which reverse-proxy hops may set the client address via X-Forwarded-For
    // (see lib/trustProxy.ts). Off by default: the desktop sidecar and a bare
    // `npm run dev` have no proxy, and trusting the header there would let any
    // client pick its own rate-limit bucket. Docker Compose sets
    // `loopback,uniquelocal` so the nginx container is trusted and the login /
    // 2FA / registration limits key on the real browser address.
    TRUST_PROXY: z.string().optional().transform(parseTrustProxy),
    // Whether /api/onboarding/create accepts new accounts once a user exists.
    // The first account is always allowed so a fresh install can be set up.
    // On by default for multi-user households; set to 0/false once everyone
    // has an account so other devices on the LAN cannot sign up.
    ALLOW_REGISTRATION: boolish.default(true),
    // Default false because self-hosted LAN deployments typically run over plain
    // HTTP. Set to true when running behind an HTTPS-terminating reverse proxy.
    COOKIE_SECURE: boolish.default(false),
    // When true (or NODE_ENV=production), Fastify also serves the built
    // frontend from `STATIC_ROOT` (default `<cwd>/frontend/dist`) at `/`,
    // so the same process answers both `/api/*` and the SPA. Used by the
    // Tauri desktop sidecar; Docker Compose keeps nginx in front.
    SERVE_STATIC: boolish.optional(),
    STATIC_ROOT: z.string().optional(),
    // Nightly unattended bank sync for users with Enable Banking credentials
    // configured. On by default; set to 0/false to only sync on demand via
    // POST /api/bank-sync/sync.
    BANK_SYNC_AUTO: boolish.default(true),
    // Nightly unattended remote backup for users with a backup destination
    // configured (Sauvegarde → Sauvegarde distante). On by default; set to
    // 0/false to only back up on demand via the run-now button.
    BACKUP_AUTO: boolish.default(true),
    // Built-in mDNS/Bonjour responder: when on, the backend answers
    // multicast A-queries for `<HOOPOE_MDNS_HOSTNAME>.local` with the host's
    // non-loopback IPv4(s), so other devices on the LAN can reach the app
    // at http://hoopoe.local without a static DNS entry. On by default.
    // Fails soft when UDP 5353 is already bound (macOS mDNSResponder /
    // avahi-daemon) — the OS responder is already serving the local hostname
    // and we just log and skip. Turn off with 0/false to silence the warning.
    HOOPOE_MDNS: boolish.default(true),
    // Hostname advertised by the built-in mDNS responder. The `.local`
    // suffix is appended automatically. Lowercase ASCII [a-z0-9-] only —
    // mDNS names are case-insensitive but Bonjour normalizes to lowercase.
    HOOPOE_MDNS_HOSTNAME: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'HOOPOE_MDNS_HOSTNAME must be a lowercase DNS label')
      .default('hoopoe'),
  })
  .refine((v) => v.DB_DRIVER !== 'postgres' || !!v.DATABASE_URL, {
    message: 'DATABASE_URL is required when DB_DRIVER=postgres',
    path: ['DATABASE_URL'],
  })
  .refine((v) => v.NODE_ENV !== 'production' || !isPlaceholderSessionSecret(v.SESSION_SECRET), {
    message:
      'SESSION_SECRET is the public placeholder from .env.example. Generate a real one with ' +
      '`openssl rand -hex 32` and put it in SESSION_SECRET. To keep existing 2FA, bank-sync, ' +
      'backup and MCP secrets, also set SESSION_SECRET_PREVIOUS to the old placeholder for one ' +
      'boot so they are re-encrypted under the new key.',
    path: ['SESSION_SECRET'],
  });

function parseEnv() {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = parseEnv();

// Test-only escape hatch. `env` above is parsed once, at module-import time,
// and reused for the lifetime of this module instance — correct for
// production (process.env doesn't change after boot) but a trap in tests:
// vitest gives each test file its own module registry, but `tests/setup.ts`
// (a shared `setupFiles` entry) already imports the migrate -> client -> env
// chain for every file before that file's own top-level code runs. So a test
// file that does `process.env.AUTH_MODE = 'none'` at its top has no effect —
// this module already parsed and cached the old value.
//
// Call this *after* mutating `process.env` and *before* anything that reads
// `env.*` (e.g. before dynamically importing buildServer.js / auth.ts) to
// make the override actually take effect. It mutates the exported `env`
// object in place — same reference every importer already holds — so no
// caller needs to re-import anything. See tests/security-routes.pglite.test.ts
// for the pattern.
//
// This only patches scalar config values re-read at call time (e.g.
// `authPlugin` reads `env.AUTH_MODE` when `build()` registers it, not at
// import time). It cannot rebuild objects other modules already constructed
// from an old env value at their own import time (e.g. `db/client.ts`'s
// top-level-await `db`/`pool`/`dbDriver` singleton) — those need
// `vi.resetModules()` in the test file instead so the next dynamic import
// re-runs that module's top-level code against the refreshed process.env.
export function refreshEnvForTests(): void {
  // Cheap guard against accidental non-test use: this mutates the shared,
  // process-wide `env` singleton in place, which is only ever safe inside a
  // test's own module registry.
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    throw new Error('refreshEnvForTests() must only be called in tests (VITEST or NODE_ENV=test)');
  }
  Object.assign(env, parseEnv());
}
