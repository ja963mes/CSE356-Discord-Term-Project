# Implementation status — CSE 356 Discord clone

This document describes **what is implemented in this repository today** and how that lines up with common project expectations (load balancing, data stores, real-time messaging, search, and frontend architecture).

## Summary

The codebase is now a **monorepo**:

- An **authentication service** (`services/auth`) providing local signup/login, session-based auth backed by **Redis**, user and identity records in **PostgreSQL** (via **Drizzle ORM**), and **OAuth 2 / OIDC** flows for Google, GitHub, and the course OIDC provider.
- Stub microservices under `services/` (`communities`, `messages`, `search`, `realtime`) so the frontend can run with local stub services.
- A **React (Vite) frontend** under `frontend/` that renders the `/stitch/` wireframes (login + main chat) and calls the backend via the Vite dev proxy.

**Not present in this repo (yet):** nginx (or any reverse proxy config), Cassandra, Elasticsearch, fully implemented WebSockets/SSE for DMs, and Postgres schemas for communities/channels/messages beyond user auth data.

---

## Expectations checklist

| Expectation | Status in this repo | Notes |
|-------------|---------------------|--------|
| **nginx as load balancer** for microservices | Not implemented | No `nginx` config or Docker Compose wiring services behind a proxy. |
| **Redis** — cache, tokens, activity | **Partially** | Redis stores **session tokens** (`session:<uuid>` → internal user id), **OAuth CSRF state** (`oauth_state:<state>`), and **temporary OAuth linking** (`oauth_temp:<token>`). No generic “user activity” or province tracking. |
| **Cassandra** for messages | Not implemented | No Cassandra client or message schema. |
| **Postgres** for communities & channels | Not implemented | Postgres holds **`users`** and **`identities`** only (auth-related). No communities/channels tables here. |
| **WebSockets (Express) or SSE for DMs** | Not implemented | No `socket.io`, `ws`, or SSE endpoints. |
| **Elasticsearch** for search | Not implemented | No Elasticsearch integration. |
| **Frontend in separate folder + middleware to backend** | **Implemented (wireframes)** | React frontend lives under **`frontend/`** (Vite + Tailwind) and renders `/stitch/` wireframes; it calls backend via the Vite dev proxy (cookies for `/auth/*`). |

---

## Implemented components

### Runtime and HTTP API

- **Express** (`services/auth/src/index.ts`): JSON body parsing, cookies, static files from `services/auth/public/`, health check.
- **Routes** (`services/auth/src/routes/auth.ts`):
  - `POST /auth/register` — local account; bcrypt password hashing.
  - `POST /auth/login` — local login; sets `session_token` cookie.
  - `POST /auth/logout` — clears session in Redis and cookie.
  - `GET /auth/google`, `/auth/google/callback` — Google OAuth.
  - `GET /auth/github`, `/auth/github/callback` — GitHub OAuth.
  - `GET /auth/oidc`, `/auth/oidc/callback` — course OIDC (`openid-client` discovery + authorization code flow).
  - `POST /auth/oauth/complete` — after OAuth, create new user + link identity or link to existing password account.
- **GET `/health`** — returns JSON `{ status, service }`.
- **GET `/`** — intended as a protected landing page (`requireAuth`); see routing note below.
- **GET `/auth/oauth/pending`** — serves `login.html` for OAuth completion UI.

### Stub microservices (for local UI)

- `services/communities` exposes `GET /channels` (sample channels for the wireframe UI).
- `services/messages` exposes `GET /messages?channelId=...` (sample channel history).
- `services/search` exposes `GET /search?q=...` (sample search results).
- `services/realtime` exposes `GET /dms/sse` (placeholder; currently returns `501 Not Implemented`).

### Middleware

- **`requireAuth`** (`services/auth/src/middleware/session.ts`): Reads `session_token` cookie, loads `session:<token>` from Redis, attaches `req.user.internal_id`, returns 401 if missing/invalid.

### Data layer (PostgreSQL)

- **Drizzle** (`services/auth/src/db/schema.ts`, `services/auth/src/db/index.ts`, `services/auth/drizzle/` migrations):
  - **`users`**: `internal_id`, `username`, optional `email`, optional `password_hash`, `profile` (JSONB), `created_at`.
  - **`identities`**: links OAuth `provider` + `provider_uid` to `users.internal_id` (unique on provider + provider_uid).

### Redis usage

| Key pattern | Purpose | TTL |
|-------------|---------|-----|
| `session:<token>` | Session → `internal_id` | 7 days |
| `oauth_state:<state>` | OAuth/OIDC state validation | 10 minutes |
| `oauth_temp:<token>` | Pending OAuth profile JSON before create/link | 10 minutes |

### Configuration

- **`services/auth/src/config/env.ts`**: Zod-validated env vars (`PORT`, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, OAuth/OIDC URLs and secrets).
- **`services/auth/src/config/oauth.ts`**: Google/GitHub URL builders; OIDC discovery and callback handling.

### Frontend

- **React + Vite**: `/stitch/` wireframes rendered as pages:
  - `frontend/src/pages/LoginPage.tsx`
  - `frontend/src/pages/ChatPage.tsx`
- **OAuth pending / legacy pages** (still served by the auth service):
  - `public/login.html` (OAuth completion UI)
  - `public/home.html` (post-login landing)

### Unused / reserved dependencies

- **`jsonwebtoken`** is listed in `package.json` but **not used** in application code; sessions are **opaque UUIDs in Redis**, not JWTs.

---

## Routing note (`GET /`)

`services/auth/src/index.ts` registers two handlers for `GET /`. In Express, the **first** matching route runs. The first registration uses `requireAuth`, so unauthenticated browser requests to `/` receive **401 JSON** rather than the redirect defined in a second `GET /` handler. Teams should treat this as something to reconcile if the product should redirect unauthenticated users to `login.html`.

---

### Future Messaging (RabbitMQ)

Implementation note only (no RabbitMQ code yet).

The intended architecture is to introduce RabbitMQ as an event/message broker between services. Typical event patterns:

- `users.*` and `auth.*`: account created, session invalidated, password reset, etc.
- `channels.*`: channel created/updated; membership changes.
- `messages.*`: message created/edited/deleted; message delivery acknowledgements (future).
- `dms.*`: DM message events once the DM transport is added (delivered over WebSockets; SSE polling is not required in the final design).

We will later decide on exchanges/queues and topic naming (usually topic exchanges) so services can publish and subscribe without tight coupling.

Deployment will be handled by Kubernetes/nginx; RabbitMQ connectivity details will be wired via environment variables and service discovery.

---

### Future DM communication (WebSockets, single channel)

For real-time messaging (especially DMs), the intended transport is a **single WebSocket connection per authenticated client**.

Design choice:
- **One WebSocket** handles both directions:
  - client sends `message.send` / `dm.input` events (user text)
  - server broadcasts `message.created` / `dm.message` events back to all connected clients that should receive them
- **No SSE polling tandem**: WebSockets already provide server push for new messages, so adding SSE in parallel would duplicate transport complexity.
- **Optional fallback**: SSE can be considered later only for clients/environments where WebSockets are unavailable, but it is not the primary mechanism.

This transport decision is compatible with introducing RabbitMQ later: once RabbitMQ is wired, services can publish/consume events and then use the WebSocket layer to fan them out to connected clients.

## Suggested next steps (for the full architecture)

To align with the expectations listed at the top of this document, future work would typically include: reverse proxy and service boundaries (e.g. nginx), message storage (e.g. Cassandra), search (e.g. Elasticsearch), real-time DM transport (WebSockets or SSE), and extending Postgres (or separate services) for communities/channels—plus a dedicated frontend that talks to APIs via a consistent middleware or BFF pattern.
