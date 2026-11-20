---
title: Configuration
sidebar_position: 2
---

# Configuration

Hoopoe reads its configuration from environment variables at boot and from
per-user settings stored in the database. This page enumerates both, plus
the default network ports the three services listen on.

## Environment variables

All defaults below are the values Hoopoe falls back to when the variable is
unset. Copy `.env.example` to `.env` before starting `docker compose up` and
fill in the fields marked **required**.

### PostgreSQL (`db` service)

| Variable | Default | Effect |
| --- | --- | --- |
| `POSTGRES_USER` | `athena` (placeholder) | **Required.** Database role the backend connects as. Also used by the Postgres image at initdb time. |
| `POSTGRES_PASSWORD` | *(none)* | **Required.** Password for `POSTGRES_USER`. Never leave the placeholder in production. |
| `POSTGRES_DB` | `athena` | Database name created on first boot. |

### Backend (`backend` service)

| Variable | Default | Valid values | Effect |
| --- | --- | --- | --- |
| `SESSION_SECRET` | *(none)* | ≥ 32 characters | **Required.** Signs the session cookie and derives the MCP payload encryption key. Generate with `openssl rand -hex 32`. Also the root key for 2FA, bank-sync and backup secrets. Production refuses the old `.env.example` placeholder (any value containing `replace-me`). Changing it signs everyone out; set `SESSION_SECRET_PREVIOUS` for one boot to keep the encrypted secrets. |
| `SESSION_SECRET_PREVIOUS` | *(unset)* | string | Only while changing `SESSION_SECRET`: the old value, for one boot. The Docker entry re-encrypts every 2FA, bank-sync, backup and MCP secret under the new key in one transaction, then logs that the variable can be removed. If left set on a later boot, the backend exits without changing anything. |
| `DATABASE_URL` | *(none)* | Postgres URL | **Required when `DB_DRIVER=postgres`.** Full connection string, e.g. `postgres://athena:…@db:5432/athena`. |
| `COOKIE_SECURE` | `false` | `true` / `false` / `1` / `0` | Marks the session cookie as `Secure`. Leave `false` on a plain-HTTP LAN deployment — otherwise the browser rejects the cookie and login silently fails. Set to `true` when running behind an HTTPS-terminating reverse proxy. |
| `NODE_ENV` | `development` | `development` / `production` / `test` | Controls Fastify logging (`pino-pretty` in development, JSON otherwise) and enables the built-in static file server when `SERVE_STATIC` is unset. Docker Compose sets this to `production`. |
| `TRUST_PROXY` | *(unset — `false`)* | `true` / hop count / comma-separated IPs, CIDRs or presets (`loopback`, `linklocal`, `uniquelocal`) | Passed to Fastify's `trustProxy`. Unset or `false` ignores `X-Forwarded-For` (desktop, bare `npm run dev`). Docker Compose sets `loopback,uniquelocal` so the nginx container is trusted and per-client rate limits (login, 2FA, registration) key on the real browser IP; nginx overwrites `X-Forwarded-For` with `$remote_addr`, so clients cannot inject entries. Only trust addresses that really are your proxy. If you put another HTTPS reverse proxy in front of nginx, every client shares that proxy's IP unless you configure nginx `real_ip` yourself. |
| `METRICS_TOKEN` | *(unset)* | string, ≥ 16 characters | Bearer token for `GET /metrics`: scrapers send `Authorization: Bearer <token>`. When unset, `/metrics` is disabled (404) unless `METRICS_PUBLIC=true`. Generate with `openssl rand -hex 32`. |
| `METRICS_PUBLIC` | `false` | `true` / `false` / `1` / `0` | Serves `/metrics` without authentication when `METRICS_TOKEN` is unset. The endpoint exposes cross-user counts and backup timestamps, so only enable it on a trusted LAN. Ignored (with a startup warning) when `METRICS_TOKEN` is set. |
| `ALLOW_REGISTRATION` | `true` | `true` / `false` | The first account (onboarding) can always be created. Once a user exists, `false` makes `POST /api/onboarding/create` return 403 `{ "error": "registration_closed" }` and hides the "create an account" link on the login page. Compose reads it from `.env`. Set it to `false` once everyone in the household has an account. |
| `PORT` | `3000` | integer | Port Fastify listens on inside the container. Docker Compose maps `BACKEND_PORT` on the host to this port. |
| `DB_DRIVER` | `postgres` | `postgres` / `pglite` | Selects the SQL backend. `postgres` uses `pg.Pool` (Docker path). `pglite` uses embedded Postgres-in-WASM (Tauri desktop, test path). |
| `PGLITE_PATH` | *(unset — in-memory)* | filesystem path | Only used when `DB_DRIVER=pglite`. When set, PGlite persists to this directory; unset means an ephemeral in-memory database. |
| `AUTH_MODE` | `session` | `session` / `none` | `session` is the LAN/Docker path: cookies + argon2id passwords, users register through onboarding. `none` disables auth entirely — every request is authenticated as a single hard-coded local user. The server entry (LAN/Docker) refuses to start with `none`; it is only for the desktop sidecar, which binds `127.0.0.1` and answers only requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]`. |
| `SERVE_STATIC` | *(unset — mirrors `NODE_ENV=production`)* | `true` / `false` / `1` / `0` | When true, Fastify also serves the built frontend from `STATIC_ROOT`. Used by the Tauri sidecar; Docker Compose keeps nginx in front instead. |
| `STATIC_ROOT` | `<cwd>/frontend/dist` | filesystem path | Directory Fastify serves the SPA from when `SERVE_STATIC` is enabled. |
| `DATA_DIR` | `/data` (Docker) / CWD (dev) | filesystem path | Root directory for user data: the PGlite file, backups, and uploads. The Tauri entry point overrides this to the OS-specific per-user data directory. |
| `OCR_LANG_PATH` | *(unset — CDN fetch)* | filesystem path | Local path to Tesseract language files. When unset, the first OCR run downloads them from a CDN, which fails on a LAN-only deployment. Docker builds bundle the files and set this variable automatically. |
| `WATCH_IMPORTS_DIR` | *(unset — feature off)* | filesystem path | Opt-in watch-folder importer. The backend polls the directory every 60 s and imports statements (`.ofx`/`.qfx`/`.csv`/`.pdf`) dropped into a subfolder named after the destination account (case- and accent-insensitive). Outcomes are recorded by renaming the file: `.imported`, `.failed` (+ sibling `.error.txt`), or `.needs-template` for PDFs without a trained template. See [Importing](../users/importing.md). |
| `BANK_SYNC_AUTO` | `1` | `1`/`0`, `true`/`false` | Nightly unattended bank sync for users who configured Enable Banking credentials in *Données → Synchronisation bancaire*. Set to `0` to disable the scheduler and only sync on demand from the UI. See [Bank sync](../users/bank-sync.md). |
| `BACKUP_AUTO` | `1` | `1`/`0`, `true`/`false` | Nightly remote backup for users who configured a destination in *Données → Sauvegarde*. Set to `0` to disable the scheduler; the "Back up now" button still works. See [Backup and recovery](../users/backup-recovery.md#remote-backups-scheduled). |

### Frontend (build-time, Vite)

The frontend is a static bundle — these variables are read at `npm run build`
time by Vite and inlined into the resulting `dist/`, not read at runtime.

| Variable | Default | Effect |
| --- | --- | --- |
| `VITE_DEMO` | *(unset)* | When set to `1`, `npm run build` produces `frontend/dist-demo/` instead of `frontend/dist/`. The bundle routes every API call through a browser-only adapter backed by seed data — no backend required. Used to publish the public GitHub Pages demo. |

### Host ports (compose overrides)

| Variable | Default | Effect |
| --- | --- | --- |
| `FRONTEND_PORT` | `8000` | Host port mapped to the frontend container's port 8080. Bound to `0.0.0.0` so other devices on your LAN can reach the app. |
| `BACKEND_PORT` | `8001` | Host port mapped to the backend container's port 3000. Published on `127.0.0.1` only, so `curl http://127.0.0.1:8001/health` works from the host but other LAN devices cannot reach it; they use the frontend, whose nginx proxies every `/api/*` call (including `/api/mcp/rpc`) to the backend. |

Avoid `6000`, `6666`, `6665–6669`, and `6697` — Chrome blocks them as
`ERR_UNSAFE_PORT`.

## Default network ports

| Service | Host port | Container port | Bind |
| --- | --- | --- | --- |
| Frontend (nginx) | `${FRONTEND_PORT:-8000}` | `8080` | `0.0.0.0` (LAN-reachable) |
| Backend (Fastify) | `${BACKEND_PORT:-8001}` | `3000` | `127.0.0.1` only (never on the LAN) |
| PostgreSQL | `5432` | `5432` | `127.0.0.1` only (never on the LAN) |

Comment out the `db` service's `ports:` block in `docker-compose.yml` if you
don't need Postgres reachable from the host at all — the backend talks to
it over the compose network regardless.

## Per-user settings (Settings page)

These persist in the `users.settings` JSON column and are edited from the
Settings page. They're per-user, not per-installation. The backend seeds the
defaults on first save; the frontend paints these same defaults while the
first fetch is in flight (source: `frontend/src/lib/settings.ts`).

| Setting | Default | Valid values | Effect |
| --- | --- | --- | --- |
| Default range (`dashboardRange`) | `3m` | `30d`, `3m`, `6m`, `12m`, `all` | Time window the Dashboard opens with on every load. The Range picker still overrides it inside a session. |
| Default account scope (`dashboardChartScope`) | `all` | `all` or an account id | Which account(s) the Dashboard charts scope to on load. `all` aggregates every account. |
| Dashed-line gap threshold (`chartGapThresholdDays`) | `6` | positive integer (days) | On the balance-over-time chart, gaps between consecutive points larger than this are drawn as a dashed line — a visual cue that data may be missing (e.g. a period with no imports). |
| Duplicate similarity threshold (`duplicateSimilarityThreshold`) | `0` | integer 0–100 | Default filter on the "Possibles doublons" list under Data → Duplicates. Groups whose label similarity is below this threshold are hidden. `0` shows every candidate group. |

*See also:* [Getting started](/docs/users/getting-started) ·
[Security and privacy](/docs/users/security-and-privacy)

← [Back to reference index](README.md)
