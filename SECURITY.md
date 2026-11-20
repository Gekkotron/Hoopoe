# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in Hoopoe,
please report it privately rather than opening a public issue.

- **Contact:** `60887050+Gekkotron@users.noreply.github.com`
- Include a description of the issue, reproduction steps, affected version(s),
  and any relevant logs or proof-of-concept material.
- Please do not disclose the vulnerability publicly until a fix has been
  released or the coordinated-disclosure window has elapsed.

## Coordinated disclosure

This project follows a **90-day coordinated-disclosure window** starting from
the date the report is acknowledged. After 90 days, reporters are free to
disclose publicly, whether or not a fix has shipped.

## No SLA

Hoopoe is a **solo-maintainer, open-source project** with no paid
support and no service-level agreement. Reports will be triaged on a
best-effort basis, and response times may vary. Critical issues are
prioritized, but there is no guaranteed time-to-fix.

## Supported versions

Only the latest release on `main` receives security fixes. Older tags and
pre-release builds are not maintained.

## Threat model

Hoopoe is designed as a **single-tenant, LAN-only** deployment
(a home mini-PC, an intranet server, or similar). By default:

- The frontend container binds to **every host interface** (`0.0.0.0`)
  so other devices on your LAN can reach the app at
  `http://<host-ip>:<port>`; its nginx proxies `/api/*` to the backend.
  The backend port (`8001`) and Postgres are published on `127.0.0.1`
  only. If you don't want LAN access, restrict with a host firewall — or
  edit `docker-compose.yml` and prefix the frontend port mapping with
  `127.0.0.1:` (e.g. `127.0.0.1:8000:8080`) and put a reverse proxy in
  front for remote access.
- Registration is **open by default**: any client that can reach the
  app can create an account, so on a LAN-exposed deployment anyone on
  your network can register. Set `ALLOW_REGISTRATION=false` in `.env`
  once everyone has an account: the first account can always be
  created, but afterwards `POST /api/onboarding/create` returns 403
  `registration_closed` and the login page hides the "create an account"
  link. A firewall or an authenticating reverse proxy is still the right
  tool for stricter access.
- A password change or a 2FA disable signs out every other session of
  that account. Five wrong 2FA codes in a row lock the account's 2FA
  check for 15 minutes, independent of the client address.
- Per-client rate limits (login, 2FA, registration) key on the client IP.
  The compose stack sets `TRUST_PROXY=loopback,uniquelocal` so the backend
  trusts the nginx container's `X-Forwarded-For`, which nginx overwrites
  with the real peer address. Only trust addresses that really are your
  proxy; if you add another HTTPS reverse proxy in front of nginx, every
  client appears as that proxy's IP unless you configure nginx `real_ip`
  yourself.
- Sessions are cookie-based with `httpOnly`; set `COOKIE_SECURE=true`
  behind an HTTPS-terminating reverse proxy so the cookie isn't
  transmitted over plain HTTP.

- The **desktop app** runs its backend without accounts, bound to
  `127.0.0.1` and answering only loopback `Host` names. To keep other local
  processes and OS users out, the shell generates a random token on every
  launch, hands it to the backend through the environment and opens its
  window with it; the backend then requires the resulting `HttpOnly`,
  `SameSite=Strict` cookie on every request (403 otherwise). `/api/mcp`
  is the one exemption, as it has its own authentication. A process running
  as the same OS user can still read the token from the backend's
  environment; the token protects against other users and unrelated
  processes, not against code already running as you.

The project is **not** intended to be reachable from the public internet
without an authenticating reverse proxy (Tailscale, Cloudflare Access,
nginx basic-auth, etc.) between it and the outside world.

## Third-party network calls

Hoopoe is designed to run without egress to the public internet. The only
subsystem that *can* reach out on its own is OCR:

- **tesseract.js** downloads `fra.traineddata` / `eng.traineddata` (~30 MB
  each) from a CDN the first time OCR runs, unless the `OCR_LANG_PATH`
  env var is set to a local directory containing those files. The
  backend logs a one-shot warning on startup-first OCR to stderr when
  the variable is missing. To stay fully offline, download the files
  once from tesseract-ocr's tessdata_fast release and point
  `OCR_LANG_PATH` at their directory.

Everything else — categorization, budgeting, imports, reports — is
computed locally against your Postgres. No telemetry, no analytics, no
LLM calls unless you explicitly wire the MCP endpoint yourself.
