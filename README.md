# Homelab Monitoring

A self-hosted, PRTG-style monitoring system for a 5-site UniFi homelab, built as a **hybrid**:
Zabbix as the collection/transport/buffering engine, plus **Argus** — a custom Go + React web
app for the UI, authentication, and per-site notifications.

## Repository layout
| Path | What |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | The full design document — single source of truth |
| [`deploy/`](deploy/README.md) | Phase 0 deploy kit: Zabbix core + probe (PKI, unRAID XML, checklist) |
| [`argus/`](argus/README.md) | The custom app (Go backend + React frontend, packaged to GHCR) |
| `.github/workflows/` | CI: builds the Argus image and pushes it to `ghcr.io/<owner>/argus` |

## Status
- **Phase 0 — Foundations:** ✅ complete. Zabbix core (10.0.0.10) + site1 probe online over
  mutual TLS, live data flowing, 7-day offline buffer verified.
- **Phase 1 — App skeleton:** 🚧 in progress. Walking skeleton first (serves UI + health +
  Zabbix reachability), then auth (3 roles, MFA, passkeys) and the token-based probe
  enrollment/PKI backend.
- Phases 2–6 (read path, dashboards, discovery/auto-provisioning, notifications, rollout):
  see the roadmap in `docs/DESIGN.md`.

## Deploy
- **Zabbix core + probes:** follow [`deploy/PHASE0-CHECKLIST.md`](deploy/PHASE0-CHECKLIST.md).
- **Argus app:** push to GitHub → CI publishes the image → `docker run` it on the core VM.
  See [`argus/README.md`](argus/README.md).
