# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project
follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

**Versioning policy:** increment the PATCH (`0.0.x`) for each change during development —
`0.0.1`, `0.0.2`, `0.0.3`, … — reserving **`1.0.0`** for the first production-ready release.
Each release is a git tag `vX.Y.Z` that triggers CI to build the versioned image and publish a
GitHub Release from the matching section below.

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
