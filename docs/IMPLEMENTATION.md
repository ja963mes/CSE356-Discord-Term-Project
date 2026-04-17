# Implementation status

What this repository implements today versus typical course expectations (multi-service messaging, storage, realtime, search, deploy).

---

## At a glance

| Area | Status |
|------|--------|
| **Auth** | Local + OAuth (Google, GitHub, OIDC); Redis sessions; Postgres users/identities |
| **Communities & channels** | Postgres + Drizzle; CRUD, ACLs; `GET /search-communities` proxies to **search** (ES); DAO layer for Postgres |
| **Channel messages** | Cassandra history; Postgres ACL; MinIO presign for attachments |
| **DMs** | Dedicated service; Cassandra; REST under `/dms` |
| **Search** | Elasticsearch + search microservice: `GET /search/messages` (session-scoped), `GET /directory/communities` (directory; Postgres → ES reindex + events) |
| **Realtime** | WebSocket `/ws` on `realtime` service; fan-out to clients |
| **Read state** | Service on **:3008**; Postgres (Drizzle) + Cassandra + Redis as implemented in `services/read-state/` |
| **Frontend** | React 18 + Vite + Tailwind; proxies in `frontend/vite.config.ts` |
| **Reverse proxy (prod)** | **Supported:** split VM examples — `docs/nginx-linode-production-frontend.conf.example` + `...-backend.conf.example` ([`PROD-SPLIT-NGINX.md`](./PROD-SPLIT-NGINX.md)). Older single-file nginx examples are **deprecated** (kept for reference only). |
| **Deploy automation** | Optional Ansible scaffold under `ansible/` ([`ANSIBLE-SETUP.md`](./ANSIBLE-SETUP.md)) |
| **Load / latency smoke tests** | k6 scripts under `k6/`; `npm run k6:routes`, `npm run k6:search-messages` |

---

## Expectations checklist (high level)

| Expectation | In this repo |
|-------------|----------------|
| **nginx / TLS** | Example configs in `docs/`; production path is **frontend VM + backend VM** ([`PROD-SPLIT-NGINX.md`](./PROD-SPLIT-NGINX.md)). |
| **Redis** | Sessions, OAuth state, ephemeral OAuth payloads; used by services for `requireAuth` patterns. |
| **PostgreSQL** | Shared app DB (migrations under `services/auth/drizzle/`): users, identities, communities, channels, memberships, etc., per actual schema. |
| **Cassandra** | Channel message timeline, DM storage, read-state paths (see per-service `env` and docs). **Note:** `docker-compose.yml` in this repo may ship Cassandra **commented out**; local full stack often expects Cassandra on **9042** (install separately or enable the compose service). |
| **Elasticsearch** | **search** service: message search + community directory index; compose includes ES for local/dev. |
| **MinIO** | S3-compatible attachments; compose service; messages service presign flow. |
| **WebSockets** | Client uses `/ws` (proxied to realtime service). |
| **RabbitMQ / K8s** | Not wired; design notes only (below). |

---

## Services (ports are defaults; override in `.env`)

| Port | Workspace / folder | Role |
|------|-------------------|------|
| **3001** | `services/auth` | Auth, OAuth, static login assets, `/health` |
| **3002** | `services/communities` | Guilds, channels, members; `/search-communities` → search (ES) |
| **3003** | `services/messages` | Channel messages, `/attachments` presign |
| **3004** | `services/search` | Message + directory search (ES), `/health` pings ES |
| **3005** | `services/realtime` | WebSocket server |
| **3006** | `services/create-community` | Create guild + seed `#general` |
| **3007** | `services/dms` | Direct messages API |
| **3008** | `services/read-state` | Read receipts / unread state |
| **5173** | `frontend` | Vite dev server (SPA) |

---

## Frontend ↔ backend

The SPA talks to backends through **path-based proxies** in `frontend/vite.config.ts`. **Prefix order matters** (e.g. `/search-communities` before `/search`). Per-path origins can be overridden with `VITE_*_ORIGIN` env vars (see that file).

---

## Docker Compose (repo root)

`docker compose up -d` is intended for **data plane dependencies**. Check [`docker-compose.yml`](../docker-compose.yml) for the current list; typically includes **Postgres**, **PgBouncer**, **Redis**, **Elasticsearch**, and **MinIO**. **Cassandra** may be optional/commented—enable or run Cassandra separately for messages/DMs/read-state.

---

## Future work (not a status claim)

- **RabbitMQ (or similar)** for async domain events between services.
- **Postgres sharding** by community / operational scaling ([`sharding-and-replication.md`](./sharding-and-replication.md)).
- **Kubernetes** / advanced service mesh (optional for course scale).

Design notes for WebSockets + eventual broker integration remain valid: a **single WS** per client for bidirectional realtime; broker would feed the realtime layer rather than replacing it.

---

## Auth routing note

`services/auth` registers more than one handler for `GET /`; the first match wins. If unauthenticated users should see a redirect instead of JSON, reconcile that ordering intentionally.

---

## Related docs

- **[docs/README.md](./README.md)** — full documentation index  
- **[docs/CLAUDE.md](./CLAUDE.md)** — AI/editor-oriented project map  
- **[docs/STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md)** — staging host runbook  
- **[README.md](../README.md)** — clone, quick start, scripts  
