# CSE 356 - Messaging System (Discord Clone)

## Project Overview
A cloud-hosted, real-time text messaging app (Discord clone) built as a microservices monorepo.

**Stack:** Node.js + Express + TypeScript | React 18 + Vite + Tailwind | PostgreSQL + Drizzle ORM | Redis | WebSockets

## Monorepo Structure
```
services/
  auth/        # Port 3001 - Auth (COMPLETE: local + OAuth Google/GitHub/OIDC)
  communities/ # Port 3002 - Communities & channels (STUB)
  messages/    # Port 3003 - Message storage & retrieval (STUB)
  search/      # Port 3004 - Full-text search (STUB)
  realtime/    # Port 3005 - WebSocket real-time events (STUB)
frontend/      # Port 5173 - React Vite app (wireframe UI done)
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
- **Auth service** (services/auth/): local login/register, Google OAuth, GitHub OAuth, OIDC (course provider), session management via Redis UUIDs (7-day TTL), PostgreSQL user/identity schema via Drizzle ORM
- **Frontend wireframe**: Discord-style 3-column UI, login page with OAuth buttons, stub API clients with fallback data
- **Stub services**: communities, messages, search, realtime (all return placeholder data)

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

### 4. Channels (within communities)
- Public/private channels per community
- Only community admins can create channels or toggle private/public
- Users join channels to read history; private channel grants full history access
- DB schema: `channels`, `channel_members` tables

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
/auth     → localhost:3001
/channels → localhost:3002
/messages → localhost:3003
/search   → localhost:3004
/dms      → localhost:3005
```

## Coding Conventions
- TypeScript everywhere (strict mode)
- Zod for env validation (`services/auth/src/config/env.ts` as reference)
- Drizzle ORM for PostgreSQL schemas (migrations in `services/auth/drizzle/`)
- Each service is an npm workspace with its own `package.json`
- Keep services independently deployable
