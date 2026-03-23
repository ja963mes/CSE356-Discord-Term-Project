# Implementation status — CSE 356 Discord clone

This document describes **what is implemented in this repository today** and how that lines up with common project expectations (load balancing, data stores, real-time messaging, search, and frontend architecture).

## Summary

The codebase is an **authentication service** (`auth-service`): one **Express 5** application that provides local signup/login, session-based auth backed by **Redis**, user and identity records in **PostgreSQL** (via **Drizzle ORM**), and **OAuth 2 / OIDC** flows for Google, GitHub, and the course OIDC provider. Static HTML in `public/` implements a minimal login UI served by the same server.

**Not present in this repo:** nginx (or any reverse proxy config), Cassandra, Elasticsearch, WebSockets or SSE for DMs, separate microservices, a dedicated SPA frontend folder with API middleware, or Postgres schemas for communities/channels/messages beyond user auth data.

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
| **Frontend in separate folder + middleware to backend** | **Partial** | UI lives under **`public/`** as static HTML/JS calling `/auth/*` on the **same origin**. There is no separate frontend package or Next/Vite app; **`requireAuth`** in `src/middleware/session.ts` is server-side middleware only (not a frontend API layer). |

---

## Implemented components

### Runtime and HTTP API

- **Express** (`src/index.ts`): JSON body parsing, cookies, static files from `public/`, health check.
- **Routes** (`src/routes/auth.ts`):
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

### Middleware

- **`requireAuth`** (`src/middleware/session.ts`): Reads `session_token` cookie, loads `session:<token>` from Redis, attaches `req.user.internal_id`, returns 401 if missing/invalid.

### Data layer (PostgreSQL)

- **Drizzle** (`src/db/schema.ts`, `src/db/index.ts`, `drizzle/` migrations):
  - **`users`**: `internal_id`, `username`, optional `email`, optional `password_hash`, `profile` (JSONB), `created_at`.
  - **`identities`**: links OAuth `provider` + `provider_uid` to `users.internal_id` (unique on provider + provider_uid).

### Redis usage

| Key pattern | Purpose | TTL |
|-------------|---------|-----|
| `session:<token>` | Session → `internal_id` | 7 days |
| `oauth_state:<state>` | OAuth/OIDC state validation | 10 minutes |
| `oauth_temp:<token>` | Pending OAuth profile JSON before create/link | 10 minutes |

### Configuration

- **`src/config/env.ts`**: Zod-validated env vars (`PORT`, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, OAuth/OIDC URLs and secrets).
- **`src/config/oauth.ts`**: Google/GitHub URL builders; OIDC discovery and callback handling.

### Frontend (minimal)

- **`public/login.html`**: Tabs for sign-in/sign-up, OAuth buttons, pending-OAuth create/link flows (fetch to `/auth/*`).
- **`public/home.html`**: Post-login landing (loaded when authenticated).

### Unused / reserved dependencies

- **`jsonwebtoken`** is listed in `package.json` but **not used** in application code; sessions are **opaque UUIDs in Redis**, not JWTs.

---

## Routing note (`GET /`)

`src/index.ts` registers two handlers for `GET /`. In Express, the **first** matching route runs. The first registration uses `requireAuth`, so unauthenticated browser requests to `/` receive **401 JSON** rather than the redirect defined in a second `GET /` handler. Teams should treat this as something to reconcile if the product should redirect unauthenticated users to `login.html`.

---

## Suggested next steps (for the full architecture)

To align with the expectations listed at the top of this document, future work would typically include: reverse proxy and service boundaries (e.g. nginx), message storage (e.g. Cassandra), search (e.g. Elasticsearch), real-time DM transport (WebSockets or SSE), and extending Postgres (or separate services) for communities/channels—plus a dedicated frontend that talks to APIs via a consistent middleware or BFF pattern.
