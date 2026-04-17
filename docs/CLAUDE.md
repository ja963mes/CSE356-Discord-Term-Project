# CSE 356 - Messaging System (Discord Clone)

## Project Overview
A cloud-hosted, real-time text messaging app (Discord clone) built as a microservices monorepo.

**Stack:** Node.js + Express + TypeScript | React 18 + Vite + Tailwind | PostgreSQL + Drizzle ORM | Cassandra (channel + DM messages) | Redis | WebSockets

## Monorepo Structure
```
services/
  auth/             # Port 3001 - Auth (local + OAuth Google/GitHub/OIDC)
  create-community/ # Port 3006 - Create community (100/user cap, seeds #general)
  communities/      # Port 3002 - Guilds, directory search, channels (CRUD + ACLs); Postgres DAOs under src/dao/
  messages/         # Port 3003 - Channel messages (Cassandra history; Postgres ACL + session; MinIO presign)
  search/           # Port 3004 - Message search (Elasticsearch + Postgres scope for membership)
  realtime/         # Port 3005 - WebSocket /ws fan-out
  dms/              # Port 3007 - Direct messages (Cassandra)
  read-state/       # Port 3008 - Read receipts / unread (Postgres + Cassandra + Redis)
frontend/           # Port 5173 - React Vite app
```

## Dev Commands
```bash
npm run dev:auth          # Start auth service
npm run dev:communities   # Start communities service
npm run dev:messages      # Start messages service
npm run dev:search        # Start search service (Elasticsearch for message search)
npm run dev:realtime      # Start realtime service
npm run dev:read-state    # Start read-state service
npm run dev:frontend      # Start frontend
npm run db:generate       # Generate Drizzle migrations
npm run db:migrate        # Run migrations
```

## What's Already Done
- **Auth** (`services/auth/`): local login/register, OAuth (Google, GitHub, OIDC), Redis sessions, Drizzle + migrations (shared Postgres)
- **Create-community** (`services/create-community/`): 100 communities/user cap, seeds `#general`, owner membership
- **Communities** (`services/communities/`): list/join/leave, members, `GET /search-communities` (proxies to **search-service** / Elasticsearch), channels (public/private, `channel_members`, admin CRUD); **Postgres DAO layer** under `src/dao/`
- **Messages** (`services/messages/`): `GET/POST /messages`, ACLs, Cassandra history, attachment presign (MinIO)
- **Search** (`services/search/`): Elasticsearch-backed `GET /search/messages` and **`GET /directory/communities`** (directory index synced from Postgres + Redis events)
- **Realtime** (`services/realtime/`): WebSocket `/ws` for delivery fan-out
- **DMs** (`services/dms/`): DM REST API backed by Cassandra (see DEV-27)
- **Read-state** (`services/read-state/`): read/unread service on :3008
- **Frontend**: React UI, Vite proxy map aligned with services

## What Still Needs to Be Built (by spec section)

### 2. Profile & Presence
- Add `presence` field to user profile (online/idle/away/offline)
- Track last activity time per WebSocket connection
- `online`: active connection + activity within 1 min
- `idle`: active connection, no activity in 1 min
- `away`: user-set override (with optional away message)
- `offline`: no connections

### 3. Communities
- **Implemented:** create (100/user cap via create-community), join, leave, membership listing; Postgres `communities` / `community_members` (see migrations).
- **Polish / product:** richer presence in member list, invites — see §2 and frontend backlog.

### 4. Channels (within communities) — requirements & status

**Product rules**
- Each community has **channels**; each is **public** or **private** (`channels.is_private`).
- **Sidebar**: community members see **public** channels + **private** channels where they have a `channel_members` row.
- **Admin-only** (`community_members.role` is `owner` or `admin`): create channels, PATCH `is_private` / `name` / `position`. No per-channel owner beyond community roles.
- **History**: users read history only if they have **`channel_members`** for that channel. Joining a community **auto-adds** `channel_members` for all **public** channels (migration backfills existing members). **Private**: admin uses `POST .../channels/:channelId/members` with `{ "user_id" }`.
- **Messages** (§6): **messages** service must enforce the same rules when serving/storing channel messages.

**Architecture (current)**  
Channel lifecycle and ACLs live on the **communities service (3002)** — no separate `channels` microservice for now. Same Postgres + Drizzle schema copies as auth.

**Done (scaffold)**  
- Migration **`0006_*`**: `channel_members` table, `channels.is_private`, backfill public-channel membership for existing `community_members`.  
- **create-community**: seeds `#general` as public and inserts owner into `channel_members`.  
- **Join community**: adds user to all public channels’ `channel_members`. **Leave community**: removes user’s `channel_members` for channels in that guild.  
- **Routes** (all under `/communities/...`, session required except N/A): `GET .../channels` (with `joined`), `POST .../channels`, `PATCH .../channels/:channelId`, `POST .../join`, `POST .../leave`, `POST .../members`.

**Still to do for section 4 / cross-cutting**  
- **messages**: ~~authorize channel reads/writes~~ — implemented on messages service; optional “join” UX polish.  
- **Frontend**: promote `admin`; private-channel request-access flow (channel member management UI is implemented).  
- Optional: **`GET .../channels-overview?include=recent`** for one round-trip with message previews (after messages API exists).  
- Optional: promote members to `admin` role (schema already allows `admin` string).

### 5. Direct Conversations
- 1-to-1 and group DMs (no community association)
- Group DMs: any member can invite; members can leave voluntarily
- History deleted when last member leaves; new group with same participants = new empty history
- DB schema: `direct_conversations`, `dm_participants` tables

### 6. Messages
- Real-time delivery via WebSocket for connected users
- Stored permanently (channels) or until last member leaves (DMs)
- Fields: id (UUID), author, timestamp, unicode text content, up to 4 image attachments
- Infinite scroll / pagination (load older messages on scroll up)
- Unread notification badges even when not in a channel
- Edit & delete own messages (real-time propagation)

### 7. Search
- **Implemented:** Elasticsearch + `search` service for **`GET /search/messages`** (scopes, filters) and **`GET /directory/communities`** (public guild names). **`GET /search-communities`** on communities is a **BFF** (Redis cache + HTTP to search).
- **Ongoing / product:** index freshness tied to subscriber + startup reindex; rename/delete flows may need extra ES events if added later.

### 8. Read State
- **Service:** `read-state` on :3008 (see repo for current storage mix: Cassandra / Postgres as implemented).
- **Spec gaps:** per-device vs global semantics, full read-receipt UX for all surfaces — align with course spec as needed.

## Key Architecture Decisions
- **Sessions**: Opaque UUID tokens in Redis (`session:<token>` → `internal_id`), cookie `session_token`
- **Auth middleware**: `requireAuth` in `services/auth/src/middleware/session.ts`
- **OAuth state**: Redis `oauth_state:<state>` (10 min TTL), temp profile `oauth_temp:<token>`
- **DB tables**: `users` (internal_id UUID PK, username, email, password_hash, profile JSONB), `identities` (provider + provider_uid unique)
- **Channels vs communities**: Shared Postgres; **channel CRUD + ACLs on communities (3002)** (see §4). **Messages service (3003)** enforces `channel_members` + `community_members` and stores message rows in **Cassandra** (partition `channel_id`).
- **WebSocket**: Single connection per client to `realtime` on `/ws` (proxied from Vite); see service for protocol/events
- **`jsonwebtoken`** is installed but unused — sessions are Redis-backed UUIDs, keep it that way

## Course OAuth Provider
- Discovery URL: `https://infraauth.cse356.compas.cs.stonybrook.edu/realms/oauth/.well-known/openid-configuration`
- Client ID: `web-service`
- Client Secret: `web-service-secret`
- Realm: `oauth`

## Known Issues / Tech Debt
- `services/auth/src/index.ts` has duplicate `GET /` handlers — first one (`requireAuth`) wins; unauthenticated users may get 401 JSON instead of redirect
- Frontend may still degrade gracefully when optional services are down (staging without ES, etc.)
- `passport` is installed but not actively used (sessions bypass it)
- Nginx: use **`docs/nginx-linode-production-frontend.conf.example`** + **`docs/nginx-linode-production-backend.conf.example`** only; older single-file examples in `docs/` are **deprecated** (see `docs/README.md`, `docs/PROD-SPLIT-NGINX.md`)
- RabbitMQ not yet integrated (needed for inter-service events)

## Frontend Proxy Config (vite.config.ts)
```
/auth               → localhost:3001
/create-community   → localhost:3006
/communities        → localhost:3002
/search-communities → localhost:3002
/channels           → localhost:3002 (legacy path; channel APIs use `/communities/.../channels`)
/messages           → localhost:3003
/attachments        → localhost:3003 (presign for guild channel uploads)
/search             → localhost:3004
/ws                 → localhost:3005 (WebSocket)
/dms                → localhost:3007
/read-state         → localhost:3008
```

## Coding Conventions
- TypeScript everywhere (strict mode)
- Zod for env validation (`services/auth/src/config/env.ts` as reference)
- Drizzle ORM for PostgreSQL schemas (migrations in `services/auth/drizzle/`)
- Each service is an npm workspace with its own `package.json`
- Keep services independently deployable
