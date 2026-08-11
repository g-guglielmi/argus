# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project
follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

**Versioning policy:** increment the PATCH (`0.0.x`) for each change during development —
`0.0.1`, `0.0.2`, `0.0.3`, … — reserving **`1.0.0`** for the first production-ready release.
Each release is a git tag `vX.Y.Z` that triggers CI to build the versioned image and publish a
GitHub Release from the matching section below.

---

## [0.0.8] - 2026-08-11

**Read path — hosts & sensors.** The first monitoring-facing feature: Argus now reads live
data from Zabbix and shows it. A flat host list with per-host sensor values; graphs land next.

### Added
- **Monitoring** tab: lists Zabbix hosts with a status dot (OK / Warning / Error, derived from
  active trigger severity) and a problem count. Click a host to expand its **sensors** with the
  latest value + units and how long ago each was checked.
- **Authenticated Zabbix client**: read calls use an API token via a Bearer header
  (Zabbix 7.0 style). New methods `host.get`, `item.get`, `trigger.get`.
- Endpoints: `GET /api/hosts`, `GET /api/hosts/{id}/items` (any signed-in user).
- New config: `ARGUS_ZABBIX_API_TOKEN` (create it in Zabbix under Users → API tokens).

### Notes
- Severity mapping: Zabbix info/unclassified → OK, warning → Warning, average/high/disaster →
  Error. Without a token the health probe still works but Monitoring returns a clear error.

### Not yet (upcoming slices)
- Per-sensor history/trend **graphs** with the 2h/2d/1M/3M/6M/1Y time tabs, self-service email
  reset, login rate-limiting, and the probe enrollment/PKI backend.

---

## [0.0.7] - 2026-08-11

### Changed
- Widened the app's content area (max width 820 → 1200px) so the Dashboard and the Users
  table use more of the screen on desktop/wide displays. Individual forms keep their own
  narrower max-widths for readability, and the layout still scales down on phones/tablets.

---

## [0.0.6] - 2026-08-11

**WebAuthn passkeys.** Passwordless, phishing-resistant sign-in that completes the
auth-hardening track. Uses discoverable (resident) credentials, so login needs no username —
the authenticator lists available passkeys. Works with Bitwarden, platform authenticators
(Windows Hello, Face ID/Touch ID), and hardware security keys.

### Added
- **Register passkeys** in Account: add multiple, name each, see when they were added and
  last used, and remove them individually.
- **Passwordless login**: a "Sign in with a passkey" button on the sign-in screen runs a
  discoverable-credential ceremony and starts a session on success.
- **Admin "Reset passkeys"** on the Users table (with a per-user passkey count) to recover a
  locked-out account.
- Endpoints: `GET /api/features`, `POST /api/login/passkey/{begin,finish}`,
  `GET /api/me/passkeys`, `POST /api/me/passkeys/register/{begin,finish}`,
  `DELETE /api/me/passkeys/{id}`, `POST /api/users/{id}/passkeys/reset`.
- New config: `ARGUS_RP_ID`, `ARGUS_RP_DISPLAY_NAME`, `ARGUS_RP_ORIGINS`.

### How it degrades
- Passkeys are **feature-gated**: they appear only when the server is configured
  (`ARGUS_RP_ID` + `ARGUS_RP_ORIGINS`) **and** the page is a secure context (HTTPS or
  localhost). Reaching Argus by private IP over plain HTTP simply hides the passkey UI and
  falls back to password + TOTP — WebAuthn RP IDs can't be a bare IP.

### Changed
- The admin user list now reports a passkey count per user.
- Additive SQLite migration adds a `webauthn_handle` column and the `passkeys` and
  `webauthn_sessions` tables (no manual steps).

### Not yet (upcoming slices)
- Self-service email password reset, login rate-limiting, and the probe enrollment/PKI backend.

---

## [0.0.5] - 2026-08-11

**MFA usability fixes** from first-run validation.

### Fixed
- **Copy recovery codes** now works over plain HTTP on a private IP. `navigator.clipboard`
  only exists in a secure context, so the button silently did nothing when Argus was reached
  by IP over HTTP; it now falls back to a `textarea` + `execCommand('copy')` and shows a
  brief "Copied!" confirmation.

### Changed
- The two-factor login step now includes a visually-hidden `autocomplete="username"` field
  (the account email) so password managers such as **Bitwarden** recognize it as a login form
  and offer to autofill the one-time code; the code input also carries a stable `id`.

---

## [0.0.4] - 2026-08-11

**Two-factor authentication (TOTP).** Optional, self-service, and standards-based so it
works with authenticator apps and password managers (Bitwarden, 1Password, Google/Microsoft
Authenticator) — both scanning the QR and pasting the setup key.

### Added
- **TOTP enrollment** in Account: shows a QR code and the base32 setup key, then confirms
  with a live 6-digit code before turning MFA on (RFC 6238 defaults: SHA1 / 6 digits / 30s).
- **Two-step login**: when a user has MFA on, a correct password yields a short-lived
  challenge (no session yet); the second step verifies the code and then signs in. The code
  field is marked `autocomplete="one-time-code"` so Bitwarden can autofill it.
- **One-time recovery codes** (10) generated when MFA is enabled, shown once with copy and
  download; usable in place of a code at login. Regenerate at any time (re-auth required).
- **Disable MFA** yourself (re-auth with your password), and an admin **"Reset 2FA"** action
  on the Users table to recover a locked-out account.
- Endpoints: `POST /api/login/totp`, `GET`/`POST /api/me/mfa`,
  `POST /api/me/mfa/{setup,enable,disable,recovery-codes}`, `POST /api/users/{id}/mfa/reset`.

### Changed
- `GET /api/me` and the user list now report `mfa_enabled`.
- Additive SQLite migration adds `totp_secret` / `totp_enabled` to existing databases and
  creates the `recovery_codes` and `mfa_challenges` tables (no manual steps).

### Not yet (upcoming slices)
- WebAuthn passkeys, self-service email password reset, login rate-limiting, and the probe
  enrollment/PKI backend.

---

## [0.0.3] - 2026-08-11

**User management.** Makes the role model usable — admins can now manage the other accounts.

### Added
- Admin-only **user management**: list users, create, change role, reset password, delete.
- **Role enforcement** on the user endpoints (helpdesk/viewer receive 403).
- **Change-my-password** for any signed-in user (verifies the current password).
- Guardrails: you can't delete your own account, can't delete or demote the **last admin**,
  passwords must be ≥ 8 characters, and a duplicate email returns a clear conflict.
- Endpoints: `GET`/`POST /api/users`, `PATCH`/`DELETE /api/users/{id}`,
  `POST /api/users/{id}/password`, `POST /api/me/password`.
- UI: top navigation (Dashboard / Users / Account), a Users table with an add-user form and
  per-row role/reset/delete controls, and an Account password-change form.

### Not yet (upcoming slices)
- TOTP MFA, WebAuthn passkeys, self-service email reset, and the probe enrollment/PKI backend.

---

## [0.0.2] - 2026-08-11

**Authentication.** Adds persistent users, password login with sessions, and the role model —
the first real feature on top of the skeleton.

### Added
- **Embedded SQLite** persistence in the data volume (`argus.db`) for users and sessions.
- **Password login** using argon2id hashing and server-side sessions (HttpOnly cookie; session
  ids are stored hashed, so a DB leak can't yield usable tokens).
- **Three roles** recorded on each user: `admin`, `helpdesk`, `viewer`.
- **First-run admin bootstrap** from `ARGUS_ADMIN_EMAIL` / `ARGUS_ADMIN_PASSWORD` (only when the
  database has no users yet).
- **Endpoints:** `POST /api/login`, `POST /api/logout`, `GET /api/me` (auth-protected).
- **UI:** a sign-in screen and an authenticated dashboard showing the current user, role, and a
  log-out button.

### Changed
- New configuration: `ARGUS_ADMIN_EMAIL`, `ARGUS_ADMIN_PASSWORD`, `ARGUS_COOKIE_SECURE`.
- Image now builds with Go 1.24 and resolves modules via `go mod tidy` at build time.

### Not yet (upcoming slices)
- Role enforcement on write actions, user-management UI, TOTP MFA, WebAuthn passkeys,
  self-service password reset, and the probe enrollment/PKI backend.

---

## [0.0.1] - 2026-08-11

**Initial release.** Establishes the two foundations of the system: a validated Zabbix-based
collection layer, and the first "walking skeleton" of **Argus** (the custom web app), packaged
for automated delivery to GitHub Container Registry.

### Added — Argus application (`argus/`)
- **Go backend** that serves an embedded React single-page app from a single binary/container.
- **Health endpoints:** `GET /healthz` (liveness) and `GET /api/health`, which reports backend
  status and whether the Zabbix JSON-RPC API is reachable (with its version).
- **Zabbix API client** (JSON-RPC) with an unauthenticated `apiinfo.version` connectivity check.
- **Environment-based configuration** (`ARGUS_LISTEN`, `ARGUS_ZABBIX_API_URL`, `ARGUS_DATA_DIR`)
  so the container is configured entirely via `docker run`.
- **React + Vite frontend** showing live backend and Zabbix status, with a dark theme.

### Added — delivery & CI
- **Multi-stage Dockerfile:** build frontend → build Go binary (frontend embedded) → minimal
  distroless runtime image.
- **GitHub Actions** workflow that builds and pushes `ghcr.io/<owner>/argus` (`:latest` on the
  default branch, `:vX.Y.Z` on tags) and auto-publishes a GitHub Release for each tag.

### Added — deployment kit (`deploy/`)
- `setup-core.sh` — installs Zabbix 7.0 + PostgreSQL 17 + TimescaleDB on Debian 13, including
  auto-pinning TimescaleDB to a Zabbix-supported 2.28.x.
- `gen-certs.sh` — one shared CA + unique per-site mutual-TLS client certs; supports adding a
  new site with a single command.
- `zabbix_server.conf.snippet` — mutual-TLS config, tuning, and the TimescaleDB compatibility flag.
- `run-probe.sh` and an **unRAID template** for deploying an active proxy (single container,
  mTLS, 7-day offline buffer).
- `PHASE0-CHECKLIST.md` (command-by-command runbook) and `README.md` (including a documented
  TimescaleDB version-regression fix).

### Added — documentation
- `docs/DESIGN.md` — the full system design (architecture, device classes, thresholds, state
  model, notifications, auth, roadmap).
- Top-level `README.md` describing the repository layout and status.

### Project milestone (infrastructure validated outside the repo)
- Zabbix 7.0 core live on Debian 13 (`10.0.0.10`) with PostgreSQL 17 + TimescaleDB 2.28.3.
- The **site1** active proxy is online over mutual TLS; live ICMP data flows through it; the
  7-day offline buffer was verified by backfill after a simulated outage.

### Notes
- TimescaleDB is pinned to 2.28.x because Zabbix 7.0 rejects 2.29+.
- This is a **walking skeleton**: authentication, the PKI/enrollment backend, dashboards,
  auto-discovery, and notifications are not yet implemented — they arrive in later releases.
