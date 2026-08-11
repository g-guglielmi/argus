# Argus

The custom monitoring "cockpit" — a Go backend that serves an embedded React SPA and talks
to Zabbix via its JSON-RPC API. App data (users, roles, config, CA, enrollment tokens) lives
in embedded SQLite; metrics stay in Zabbix/TimescaleDB and are read through the API.

Current state: **Phase 1 walking skeleton** — serves the SPA, exposes health endpoints, and
checks Zabbix reachability. Auth, PKI/enrollment, dashboards, and notifications come next.

## Layout
```
argus/
  main.go                 entrypoint (HTTP server, graceful shutdown)
  internal/config/        env-based configuration
  internal/zabbix/        Zabbix JSON-RPC client (APIVersion for now)
  internal/server/        HTTP routes + embedded SPA serving
  web/                    React + Vite frontend (built into the binary via go:embed)
  Dockerfile              multi-stage: build frontend -> build Go -> distroless
```

## Endpoints
- `GET /healthz` — liveness (no dependencies)
- `GET /api/health` — readiness; includes whether the Zabbix API is reachable + its version
- `GET /*` — the React SPA

## Build & deploy (via GitHub -> GHCR -> docker run)
1. Push this repo to GitHub. The `build` workflow builds the image and pushes it to
   `ghcr.io/<your-account>/argus` (`:latest` on the default branch, `:vX.Y.Z` on tags).
2. The package starts **private**. Either make it public (GitHub → Packages → argus →
   Package settings → visibility), or on the core VM run
   `docker login ghcr.io -u <user>` with a PAT that has `read:packages`.
3. On the core VM (10.0.0.10):

```bash
docker run -d \
  --name argus \
  --restart unless-stopped \
  -p 8081:8080 \
  -e ARGUS_ZABBIX_API_URL=http://10.0.0.10:8080/api_jsonrpc.php \
  -v /mnt/data/argus:/data \
  ghcr.io/<your-account>/argus:latest
```

> Port note: the Zabbix web UI already uses host **8080**, so Argus is published on host
> **8081** (→ container 8080). Behind HAProxy later it'll be `monitoring.example.com`.

4. Open `http://10.0.0.10:8081` — you should see the Argus page reporting the backend as `ok`
   and the Zabbix API as **reachable** with its version. That confirms the whole
   GitHub → GHCR → docker run → Zabbix chain works end to end.

## Local development (optional, needs Go 1.22+ and Node 20+)
```bash
# terminal 1 — backend
cd argus && ARGUS_ZABBIX_API_URL=http://<reachable-zabbix>:8080/api_jsonrpc.php go run .
# terminal 2 — frontend with hot reload (proxies /api to :8080)
cd argus/web && npm install && npm run dev
```

## Configuration (env vars)
| Var | Default | Purpose |
|---|---|---|
| `ARGUS_LISTEN` | `:8080` | address the server listens on |
| `ARGUS_ZABBIX_API_URL` | *(empty)* | Zabbix JSON-RPC endpoint |
| `ARGUS_DATA_DIR` | `/data` | SQLite + CA store location (mount a volume) |
