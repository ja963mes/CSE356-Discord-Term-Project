# Staging rollout runbook

Use this runbook to deploy and validate the chat path on a **staging VM** before production.

## Scope

Typical Node processes on staging:
- `auth` (3001) — session + identity
- `communities` (3002) — guild/channels/ACL, also serves `POST /create-community`
- `messages` (3003) — channel history in Cassandra + ACL checks
- `realtime` (3005) — WebSocket fan-out
- `dms` (3007) — direct messages (Cassandra)
- `read-state` (3008) — read / unread (when you run the full stack)
- **Optional:** `search` (3004) + **Elasticsearch** — often **skipped on small VMs** (RAM/CPU). For split search ingress, use [`nginx/production-search.conf.example`](./nginx/production-search.conf.example) and point frontend `/search` there; if search is absent, `/search` features will degrade.
- **Optional but recommended:** static or proxied `frontend`

Longer-term, full-text search is expected to **splinter per domain** (messages, DMs, directory, etc.) along microservice boundaries rather than one central search service—see [Search (today vs eventual splintering)](./sharding-and-replication.md#search-today-vs-eventual-splintering) in `docs/sharding-and-replication.md`.

## Current staging reality (this repo)

The staging box at **`130.245.136.45`** is expected to run the services above, plus data deps via Docker: Postgres (5433), Redis (6379), Cassandra (9042)[^cassandra-vm], and **MinIO** (9000) if you use attachments. **Do not** start the Elasticsearch container on staging unless you explicitly need it for search development.[^es-cap]

[^cassandra-vm]: **Future ops:** Cassandra is memory-capped on small staging hosts (see `docker-compose.yml` and optional `CASSANDRA_MAX_HEAP` / `CASSANDRA_MEM_LIMIT` in `.env.example`). Eventually Cassandra will run on its **own VM** and will be sized **without** those staging-only caps.
[^es-cap]: **Future ops:** Elasticsearch memory limits in this repo (for example `ELASTICSEARCH_MEM_LIMIT` in `docker-compose.yml` / `.env.example`) are **staging/local safety caps**, not production sizing guidance.

## 1) Preconditions

- A staging Postgres instance is reachable.
- A staging Redis instance is reachable.
- A staging Cassandra cluster/node is reachable.
- DNS/TLS route users to one staging host/domain (temporary IP is acceptable).
- You can set environment variables per service.
- Node.js 18+ and npm are installed on the staging host.

Keep this as staging-only. Do not reuse production secrets.
When DNS is available, replace `130.245.136.45` with your staging domain in all URL variables.

## 2) Required environment variables

At minimum, verify:

- **Auth/communities/messages/realtime**
  - `DATABASE_URL`
  - `REDIS_URL` (pubsub instance, e.g. `:6379`)
  - `KV_REDIS_URL` (KV instance, e.g. `:6380` on the same Redis VM — sessions / cache / presence)
  - `SESSION_SECRET`
  - `STAGING_HOST=130.245.136.45`
  - `FRONTEND_URL=http://130.245.136.45`
- **OAuth callback URLs (auth service)**
  - `GOOGLE_CALLBACK_URL=http://130.245.136.45/auth/google/callback`
  - `GITHUB_CALLBACK_URL=http://130.245.136.45/auth/github/callback`
  - `OIDC_CALLBACK_URL=http://130.245.136.45/auth/oidc/callback`
- **Messages/realtime (Cassandra connectivity)**
  - `CASSANDRA_CONTACT_POINTS`
  - `CASSANDRA_PORT`
  - `CASSANDRA_LOCAL_DATACENTER`
- **Messages keyspace separation**
  - `MESSAGES_CASSANDRA_KEYSPACE=messaging` (or your staging name)
- **DM service**
  - `DMS_PORT=3007`
  - `CASSANDRA_KEYSPACE=dms` (keep separate from `MESSAGES_CASSANDRA_KEYSPACE`)
- **Search / Elasticsearch (not used on staging)** — omit `ELASTICSEARCH_URL` and do not run `search-service` unless you add capacity.

Replication/consistency knobs for messages:
- `CASSANDRA_TOPOLOGY` (`simple` or `network`)
- `CASSANDRA_REPLICATION_FACTOR`
- `CASSANDRA_READ_CONSISTENCY`
- `CASSANDRA_WRITE_CONSISTENCY`

### ENV_FILE switching (local vs staging)

Backend services load the repo-root `.env` by default. You can override with `ENV_FILE`:

```bash
ENV_FILE=/path/to/.env.staging npm run dev:auth
```

A staging template lives at `docs/env.staging.example`.

## 3) Bootstrap on staging host

From the repository root on the server:

```bash
git pull
npm install
npm run build --workspace auth-service
npm run build --workspace communities-service
npm run build --workspace messages-service
npm run build --workspace realtime-service
npm run build --workspace dms-service
# optional — not deployed on staging VM (see Scope)
# npm run build --workspace search-service
npm run build --workspace frontend
```

One-time migration (shared Postgres schema):

```bash
npm run db:migrate
```

Important for this branch:
- migration `0008_*` drops Postgres `channel_messages`
- channel history is now Cassandra-backed via the messages service

If staging still has legacy `channel_messages` data you care about, export/backfill before applying `0008_*`.

## 4) Keep services always-on (systemd, recommended)

Do not rely on `npm run dev:*` in an SSH shell for staging uptime.
Use `systemd` units with restart policies so services survive SSH disconnects and host reboots.

### A. Create a shared environment file

Create `/etc/discord-staging.env`:

```bash
sudo tee /etc/discord-staging.env >/dev/null <<'EOF'
DATABASE_URL=...
REDIS_URL=...
KV_REDIS_URL=...
SESSION_SECRET=...
STAGING_HOST=130.245.136.45
FRONTEND_URL=http://130.245.136.45
GOOGLE_CALLBACK_URL=http://130.245.136.45/auth/google/callback
GITHUB_CALLBACK_URL=http://130.245.136.45/auth/github/callback
OIDC_CALLBACK_URL=http://130.245.136.45/auth/oidc/callback
CASSANDRA_CONTACT_POINTS=127.0.0.1
CASSANDRA_PORT=9042
CASSANDRA_LOCAL_DATACENTER=datacenter1
MESSAGES_CASSANDRA_KEYSPACE=messaging
CASSANDRA_TOPOLOGY=simple
CASSANDRA_REPLICATION_FACTOR=1
CASSANDRA_READ_CONSISTENCY=localOne
CASSANDRA_WRITE_CONSISTENCY=localQuorum
PORT=3001
COMMUNITIES_PORT=3002
REALTIME_PORT=3005
DMS_PORT=3007
EOF
sudo chmod 600 /etc/discord-staging.env
```

### B. Add service units

Create these files under `/etc/systemd/system/`.
Set `WorkingDirectory` to your actual repo path.

`discord-auth.service`

```ini
[Unit]
Description=Discord staging auth service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/CSE356-Discord-Term-Project
EnvironmentFile=/etc/discord-staging.env
ExecStart=/usr/bin/npm run start --workspace auth-service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`discord-communities.service`

```ini
[Unit]
Description=Discord staging communities service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/CSE356-Discord-Term-Project
EnvironmentFile=/etc/discord-staging.env
ExecStart=/usr/bin/npm run start --workspace communities-service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`discord-messages.service`

```ini
[Unit]
Description=Discord staging messages service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/CSE356-Discord-Term-Project
EnvironmentFile=/etc/discord-staging.env
ExecStart=/usr/bin/npm run start --workspace messages-service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`discord-realtime.service`

```ini
[Unit]
Description=Discord staging realtime service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/CSE356-Discord-Term-Project
EnvironmentFile=/etc/discord-staging.env
ExecStart=/usr/bin/npm run start --workspace realtime-service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`discord-dms.service`

```ini
[Unit]
Description=Discord staging DMs service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/CSE356-Discord-Term-Project
EnvironmentFile=/etc/discord-staging.env
ExecStart=/usr/bin/npm run start --workspace dms-service
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### C. Enable + verify

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now discord-auth discord-communities discord-messages discord-realtime discord-dms
sudo systemctl status discord-auth discord-communities discord-messages discord-realtime discord-dms --no-pager
```

Follow logs:

```bash
sudo journalctl -u discord-auth -f
sudo journalctl -u discord-communities -f
sudo journalctl -u discord-messages -f
sudo journalctl -u discord-realtime -f
sudo journalctl -u discord-dms -f
```

### Using tmux instead of systemd (quick dev-only)

If you’re using `tmux` for “keep running after SSH disconnect”, create one window per service and run:

```bash
npm run dev --workspace auth-service
npm run dev --workspace communities-service
```

This does **not** restart on reboot; prefer systemd for stability.

## 5) Nginx reverse proxy

In staging, avoid binding raw service ports publicly; prefer one ingress host with path routing.

**Supported nginx baselines (split frontend + backend):** see [`PROD-SPLIT-NGINX.md`](./PROD-SPLIT-NGINX.md).

- **Backend VM / API ingress (staging or production):** [`nginx/production-backend.conf.example`](./nginx/production-backend.conf.example)  
  Proxies core API prefixes including `messages`, `attachments`, `dms`, and `/ws` (search route removed; use dedicated search ingress template).
- **Frontend VM (optional on staging):** [`nginx/production-frontend.conf.example`](./nginx/production-frontend.conf.example)  
  Serves static `frontend/dist` and proxies API/WS to the backend VM. Point `BACKEND_UPSTREAM` at your API host.

**Single staging box without a separate frontend VM:** run Node services locally on the box, use the **backend** example as the only nginx site (API + `/ws`), and run the SPA from **Vite on your laptop** against that host; *or* merge the `location` blocks from the frontend + backend examples into one `server` block (keep the same path order as `frontend/vite.config.ts`).

**Deprecated (reference only, do not copy for new installs):** [`nginx/deprecated/linode-staging.conf.example`](./nginx/deprecated/linode-staging.conf.example), [`nginx/deprecated/linode-production-combined.conf.example`](./nginx/deprecated/linode-production-combined.conf.example), [`nginx/deprecated/linode-services-only.conf.example`](./nginx/deprecated/linode-services-only.conf.example) — superseded by the frontend + backend pair.

- API paths proxy to `127.0.0.1:3001`–`3007` as in the README proxy table (including `/attachments` → messages on `3003`).
- `server_name` should be `130.245.136.45` (or your domain).
- The **backend** example does not serve the SPA at `/` (404). Run the UI from **Vite** (`5173`) during dev, or use the **frontend** example (static `root` + `try_files`) when serving `frontend/dist`.
- After TLS (certbot or another terminator), ensure `X-Forwarded-Proto` reflects HTTPS so OAuth redirects stay correct.

Validate + reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 6) Deployment order (for updates)

Deploy in this order:

1. Data dependencies (Postgres, Redis, Cassandra, MinIO if using attachments)
2. `auth`
3. `communities` (handles `POST /create-community`)
4. `messages`
5. `dms`
6. `realtime`
7. `frontend` (if you use one)

Rationale: auth/session and ACL metadata should be healthy before messages/DMs/realtime receive traffic. **Do not** deploy `search` on this VM unless you add resources and Elasticsearch.

## 7) Update procedure (safe rolling restart)

On each deploy:

```bash
cd /opt/CSE356-Discord-Term-Project
git pull
npm install
npm run build --workspace auth-service
npm run build --workspace communities-service
npm run build --workspace messages-service
npm run build --workspace realtime-service
npm run build --workspace dms-service
npm run db:migrate
sudo systemctl restart discord-auth
sudo systemctl restart discord-communities
sudo systemctl restart discord-messages
sudo systemctl restart discord-realtime
sudo systemctl restart discord-dms
sudo systemctl status discord-auth discord-communities discord-messages discord-realtime discord-dms --no-pager
```

If frontend is local Vite on the same host:
- restart that process manager entry as well.
If frontend is static files:
- rebuild frontend and deploy `dist`, then reload nginx.

## 8) Smoke test checklist (15-20 min)

### A. Service health

- `GET /auth/health` (or root health endpoint used by your deployment)
- `GET /communities/health`
- `GET /messages/health` (should report Cassandra reachable)
- DMs: `GET /health` on `127.0.0.1:3007` (not under `/dms` in nginx; check the process directly)
- `GET /ws` handshake path is reachable (or realtime health endpoint)

### B. Session/cookie path

1. Log in on staging frontend.
2. Confirm session cookie is set.
3. Call an authenticated endpoint (for example `GET /communities`) and expect 200.

If this fails, check cookie domain + `SameSite` + `Secure` and proxy forwarding headers.

### C. Channel ACL + message write/read

1. Join or open a community where user is a member.
2. Open a channel where user has `channel_members` access.
3. `POST /messages` with `{ channelId, content }` returns 201.
4. `GET /messages?channelId=...` returns the new message.
5. Response headers include routing hints:
   - `X-Partition-Key`
   - `X-Shard-Key-Community`
   - `X-Storage-Keyspace`
   - `X-Cassandra-Replication`

### D. Realtime basic validation

1. Open two browser sessions as two users.
2. Both connect to realtime service.
3. Send a channel message from user A.
4. Verify user B sees it without refresh.

## 9) Port/conflict sanity

Default local ports are unique:
- auth `3001`
- communities `3002`
- messages `3003`
- search `3004` (not deployed on staging)
- realtime `3005`
- dms `3007`
- frontend `5173`

In staging, only expose 80/443 publicly; keep service ports bound to localhost.

## 10) Rollback plan

If rollout is unstable:

1. Roll back `frontend` first (fastest user-impact mitigation).
2. Roll back `realtime` if message delivery is noisy but REST is healthy.
3. Roll back `messages` or `dms` if Cassandra paths are failing.
4. Keep `auth` and `communities` on last known good revisions.

If schema migration `0008_*` is already applied, do not assume old Postgres message reads will work; use app rollback that still reads Cassandra.

Quick rollback commands:

```bash
cd /opt/CSE356-Discord-Term-Project
git checkout <last-known-good-commit>
npm install
npm run build --workspace auth-service
npm run build --workspace communities-service
npm run build --workspace messages-service
npm run build --workspace realtime-service
npm run build --workspace dms-service
sudo systemctl restart discord-auth discord-communities discord-messages discord-realtime discord-dms
```

## 11) Observability minimum

Track these during rollout:

- auth login success rate and 401/403 spikes
- `/messages` 5xx rate and p95 latency
- Cassandra client errors/timeouts
- websocket connection count, disconnect rate, reconnect loops
- proxy 4xx/5xx by route prefix (`/auth`, `/communities`, `/messages`, `/dms`, `/ws`)

Useful checks:

```bash
sudo systemctl status discord-auth discord-communities discord-messages discord-realtime discord-dms --no-pager
sudo journalctl -u discord-messages -n 200 --no-pager
sudo journalctl -u discord-realtime -n 200 --no-pager
```

## 12) Exit criteria

Rollout is considered healthy when:

- All deployed Node services (`auth`, `communities`, `messages`, `realtime`, `dms`) are passing health checks (excluding `search`).
- Login + authenticated communities listing works.
- Channel message write/read works across refresh.
- Realtime fan-out works for at least two concurrent clients.
- No sustained 5xx errors or reconnect storms for one observation window (for example 30-60 minutes).
