# CSE 356 - Messaging System (Discord Clone)

## Project Overview
A cloud-hosted, real-time text messaging app (Discord clone) built as a microservices monorepo.

**Stack:** Node.js + Express + TypeScript | React 18 + Vite + Tailwind | PostgreSQL + Drizzle ORM | Redis | WebSockets

## Monorepo Structure
```
services/
  auth/             # Port 3001 - Auth (COMPLETE: local + OAuth Google/GitHub/OIDC)
  create-community/ # Port 3006 - Create community (100/user cap, seeds #general)
  communities/    # Port 3002 - Guilds, directory search, channels (CRUD + ACLs on this service)
  messages/         # Port 3003 - Message storage & retrieval (stub)
  search/           # Port 3004 - Full-text search (stub)
  realtime/         # Port 3005 - WebSocket (stub)
  dms/              # Port 3007 - Direct messages service
frontend/           # Port 5173 - React Vite app
```

## Dev Commands
```bash
npm run dev:auth          # Start auth service
npm run dev:communities   # Start communities service
npm run dev:messages      # Start messages service
npm run dev:search        # Start search service
npm run dev:realtime      # Start realtime service
npm run dev:frontend      # Start frontend
npm run db:generate       # Generate Drizzle migrations
npm run db:migrate        # Run migrations
```

## What's Already Done
- **Auth service** (`services/auth/`): local login/register, OAuth (Google, GitHub, OIDC), Redis-backed sessions, Drizzle schema + migrations (shared DB)
- **Create-community** (`services/create-community/`): enforce 100 communities/user, create row + owner membership + default `#general` channel
- **Communities service** (`services/communities/`): list/join/leave, members, `GET /search-communities`, **channels** (`is_private`, `channel_members`, admin-only create/PATCH, join/leave, admin add-member for private)
- **Frontend**: Discord-style UI, login, API clients with fallbacks
- **Stub / partial**: messages, search, realtime; **dms** service in progress

## What Still Needs to Be Built (by spec section)

### 2. Profile & Presence
- Add `presence` field to user profile (online/idle/away/offline)
- Track last activity time per WebSocket connection
- `online`: active connection + activity within 1 min
- `idle`: active connection, no activity in 1 min
- `away`: user-set override (with optional away message)
- `offline`: no connections

### 3. Communities
- CRUD: create (max 100 per user), join, leave communities
- Membership list with presence info shown in UI
- DB schema: `communities`, `community_members` tables

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
- **messages**: authorize `channel_id` using `channel_members` (+ community membership as needed).  
- **Frontend**: admin UI (create channel, toggle private, add users to private); optional “join” UX for public channels when `joined: false`.  
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
- Full-text search scoped to a community or a single DM conversation
- Community search: include public channels + private channels user has access to
- Filters: author, time range
- Results: newest-first, include content/author/timestamp/jump-to-context info
- Must reflect edits and deletions in near-real-time
- Consider Elasticsearch or PostgreSQL `tsvector`

### 8. Read State
- Per-user, per-channel/DM (not per-device)
- Mark channel/DM as unread when new message arrives after user's read position
- Direct conversations: show read receipts (who has read)
- Channels: only show unread/read badge (no individual positions exposed)
- DB schema: `read_state` table (user_id, context_id, last_read_message_id)

## Key Architecture Decisions
- **Sessions**: Opaque UUID tokens in Redis (`session:<token>` → `internal_id`), cookie `session_token`
- **Auth middleware**: `requireAuth` in `services/auth/src/middleware/session.ts`
- **OAuth state**: Redis `oauth_state:<state>` (10 min TTL), temp profile `oauth_temp:<token>`
- **DB tables**: `users` (internal_id UUID PK, username, email, password_hash, profile JSONB), `identities` (provider + provider_uid unique)
- **Channels vs communities**: Shared Postgres; **channel CRUD + ACLs on communities (3002)** (see §4). **Messages** must enforce the same `channel_members` rules when serving history.
- **WebSocket**: The `realtime` service needs to become a real WebSocket server (single persistent connection per client)
- **`jsonwebtoken`** is installed but unused — sessions are Redis-backed UUIDs, keep it that way

## Course OAuth Provider
- Discovery URL: `https://infraauth.cse356.compas.cs.stonybrook.edu/realms/oauth/.well-known/openid-configuration`
- Client ID: `web-service`
- Client Secret: `web-service-secret`
- Realm: `oauth`

## Known Issues / Tech Debt
- `services/auth/src/index.ts` has duplicate `GET /` handlers — first one (requireAuth) wins, unauthenticated users get 401 JSON instead of redirect
- Stub services return hardcoded data; frontend falls back to sample data if services are down
- `passport` is installed but not actively used (sessions bypass it)
- nginx/reverse proxy not yet set up
- RabbitMQ not yet integrated (needed for inter-service events)

## Frontend Proxy Config (vite.config.ts)
```
/auth               → localhost:3001
/create-community   → localhost:3006
/communities        → localhost:3002
/search-communities → localhost:3002
/channels           → localhost:3002 (legacy path; channel APIs use `/communities/.../channels`)
/messages           → localhost:3003
/search             → localhost:3004
/ws                 → localhost:3005 (WebSocket)
/dms                → localhost:3007
```

## Coding Conventions
- TypeScript everywhere (strict mode)
- Zod for env validation (`services/auth/src/config/env.ts` as reference)
- Drizzle ORM for PostgreSQL schemas (migrations in `services/auth/drizzle/`)
- Each service is an npm workspace with its own `package.json`
- Keep services independently deployable
