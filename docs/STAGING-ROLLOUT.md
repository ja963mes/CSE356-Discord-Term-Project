# Staging rollout runbook (auth + communities + messages + realtime)

Use this runbook to deploy and validate the core chat path in a staging environment before production.

## Scope

Services covered:
- `auth` (session + identity)
- `communities` (guild/channels/ACL)
- `messages` (channel history in Cassandra + ACL checks)
- `realtime` (WebSocket fan-out/presence plumbing)
- optional but recommended: `frontend` pointed at staging APIs

## 1) Preconditions

- A staging Postgres instance is reachable.
- A staging Redis instance is reachable.
- A staging Cassandra cluster/node is reachable.
- DNS/TLS route users to one staging host/domain.
- You can set environment variables per service.

Keep this as staging-only. Do not reuse production secrets.

## 2) Required environment variables

At minimum, verify:

- **Auth/communities/messages/realtime**
  - `DATABASE_URL`
  - `REDIS_URL`
  - `SESSION_SECRET`
- **Messages/realtime (Cassandra connectivity)**
  - `CASSANDRA_CONTACT_POINTS`
  - `CASSANDRA_PORT`
  - `CASSANDRA_LOCAL_DATACENTER`
- **Messages keyspace separation**
  - `MESSAGES_CASSANDRA_KEYSPACE=messaging` (or your staging name)
- **DM service compatibility (if deployed)**
  - keep `CASSANDRA_KEYSPACE=dms` for the DMs service

Replication/consistency knobs for messages:
- `CASSANDRA_TOPOLOGY` (`simple` or `network`)
- `CASSANDRA_REPLICATION_FACTOR`
- `CASSANDRA_READ_CONSISTENCY`
- `CASSANDRA_WRITE_CONSISTENCY`

## 3) Deployment order

Deploy in this order:

1. Data dependencies (Postgres, Redis, Cassandra)
2. `auth`
3. `communities`
4. `messages`
5. `realtime`
6. `frontend` (if you use one)

Rationale: auth/session and ACL metadata should be healthy before messages/realtime start receiving traffic.

## 4) One-time migration step

Run DB migrations against staging Postgres:

```bash
npm run db:migrate
```

Important for this branch:
- migration `0008_*` drops Postgres `channel_messages`
- channel history is now Cassandra-backed via the messages service

If staging still has legacy `channel_messages` data you care about, export/backfill before applying `0008_*`.

## 5) Smoke test checklist (15-20 min)

### A. Service health

- `GET /auth/health` (or root health endpoint used by your deployment)
- `GET /communities/health`
- `GET /messages/health` (should report Cassandra reachable)
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

## 6) Port/conflict sanity

Default local ports are unique:
- auth `3001`
- communities `3002`
- messages `3003`
- search `3004`
- realtime `3005`
- create-community `3006`
- dms `3007`
- frontend `5173`

In staging, avoid binding raw service ports publicly; prefer one ingress host with path routing.

### Nginx example (Linode / single host)

An example site config that mirrors `frontend/vite.config.ts` (including **`/search-communities` before `/search`**) and upgrades **`/ws`** to the realtime service is in **[`nginx-linode-staging.conf.example`](./nginx-linode-staging.conf.example)**.

- API paths proxy to `127.0.0.1:3001`–`3007` as in the README proxy table.
- **`/`** defaults to the Vite dev server on **`5173`**; switch that block to `root` + `try_files` if you serve `frontend/dist` instead.
- After TLS (certbot or another terminator), ensure **`X-Forwarded-Proto`** reflects HTTPS so OAuth redirect URLs stay correct.

## 7) Rollback plan

If rollout is unstable:

1. Roll back `frontend` first (fastest user-impact mitigation).
2. Roll back `realtime` if message delivery is noisy but REST is healthy.
3. Roll back `messages` if Cassandra path is failing.
4. Keep `auth` and `communities` on last known good revisions.

If schema migration `0008_*` is already applied, do not assume old Postgres message reads will work; use app rollback that still reads Cassandra.

## 8) Observability minimum

Track these during rollout:

- auth login success rate and 401/403 spikes
- `/messages` 5xx rate and p95 latency
- Cassandra client errors/timeouts
- websocket connection count, disconnect rate, reconnect loops
- proxy 4xx/5xx by route prefix (`/auth`, `/communities`, `/messages`, `/ws`)

## 9) Exit criteria

Rollout is considered healthy when:

- All four services are passing health checks.
- Login + authenticated communities listing works.
- Channel message write/read works across refresh.
- Realtime fan-out works for at least two concurrent clients.
- No sustained 5xx errors or reconnect storms for one observation window (for example 30-60 minutes).
