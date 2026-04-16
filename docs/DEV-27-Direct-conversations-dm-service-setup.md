# DEV-27 — Direct conversations (DM service)

> **Port:** `3007` (`services/dms`). **Storage:** Cassandra for DM payloads; **Redis** for session auth on protected routes.

## Overview

This branch implements the **Direct Conversations** feature (1-to-1 and group DMs). DMs are not attached to any community. The DM service is a standalone Express microservice on **port 3007** backed by **Cassandra** for all DM data and **Redis** for session authentication.

---

## What Has Been Implemented (Chunks 1–4)

### Chunk 1 — Database Schema Decisions
- Decided to use **Cassandra** for all DM data (conversations, participants, messages)
- Removed DM-related tables from the PostgreSQL schema since Cassandra owns this data entirely
- PostgreSQL continues to be used only by the `auth` and `communities` services

### Chunk 2 — DM Service Scaffolding (`services/dms/`)
A new standalone service was created at `services/dms/` with the following structure:
```
services/dms/
  src/
    index.ts              # Express app — all HTTP routes
    env.ts                # Zod-validated environment config
    db.ts                 # Cassandra client + initialization logic
    redis.ts              # Redis client for session auth
    db/
      schema.ts           # CQL table definitions (auto-run on startup)
    dm/
      service.ts          # All DM business logic
    middleware/
      session.ts          # requireAuth middleware (reads Redis session)
    types/
      express.d.ts        # Express Request.user type augmentation
  package.json
  tsconfig.json
```

### Chunk 3 — Cassandra Connected and Verified
- Cassandra 4.0 added to `docker-compose.yml`
- The service auto-creates the keyspace and all tables on first boot using `CREATE KEYSPACE/TABLE IF NOT EXISTS`
- No manual CQL setup needed — just start Docker and run the service

### Chunk 4 — Core Conversation Endpoints (fully working)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/dms` | List all conversations for the current user |
| `POST` | `/dms` | Create a 1-to-1 or group conversation |
| `POST` | `/dms/:id/participants` | Invite a user to a group conversation |
| `DELETE` | `/dms/:id/participants/me` | Leave a conversation (deletes if last person) |
| `POST` | `/dms/:id/messages` | Send a message |
| `GET` | `/dms/:id/messages` | Get paginated message history |

**Key behaviours implemented:**
- 1-to-1 conversations can only have exactly 2 participants
- Group conversations always create a new conversation (same participants ≠ same history)
- When the last participant leaves, the conversation and all its messages are permanently deleted from Cassandra
- Messages support up to 4 attachments (URLs)
- Pagination via `?before=<timeuuid>&limit=<n>` (max 100, default 50)

---

## Cassandra Schema

Four tables are auto-created in the `dms` keyspace on service startup:

| Table | Purpose | Partition Key |
|-------|---------|---------------|
| `conversations` | Conversation metadata (type, name, timestamps) | `conversation_id` |
| `conversations_by_user` | Index for listing a user's conversations | `user_id` |
| `participants_by_conversation` | Who is in each conversation | `conversation_id` |
| `messages_by_conversation` | Messages, newest first | `conversation_id` |

---

## Local Development Setup

### Prerequisites
- [Node.js 20+](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)

---

### Step 1: Clone and install dependencies

```bash
git clone <repo-url>
cd auth-service
npm install
```

---

### Step 2: Set up the `.env` file

Copy the example file at the repo root:
```bash
cp .env.example .env
```

The DM service uses these env vars — **all have defaults and do not need to be set manually** for local dev:

| Variable | Default | Description |
|----------|---------|-------------|
| `DMS_PORT` | `3007` | Port the DM service runs on |
| `CASSANDRA_CONTACT_POINTS` | `127.0.0.1` | Cassandra host |
| `CASSANDRA_PORT` | `9042` | Cassandra port |
| `CASSANDRA_LOCAL_DATACENTER` | `datacenter1` | Cassandra datacenter name |
| `CASSANDRA_KEYSPACE` | `dms` | Cassandra keyspace name |
| `CASSANDRA_USERNAME` | *(unset)* | Optional — not needed for local Docker |
| `CASSANDRA_PASSWORD` | *(unset)* | Optional — not needed for local Docker |

You still need `REDIS_URL` in your `.env` for session auth — this should already be there from the auth service setup (e.g. `REDIS_URL=redis://localhost:6379`).

---

### Step 3: Start Docker containers

From the repo root:
```bash
docker compose up -d
```

This starts **PostgreSQL**, **Redis**, and **Cassandra** together.

> **Important:** Cassandra takes **30–60 seconds** to fully initialize after the container starts. If you start the DM service too early it will fail to connect. Wait until you see the ready signal in the logs:
> ```bash
> docker logs discord-clone-cassandra
> ```
> Look for a line containing:
> ```
> Starting listening for CQL clients on /0.0.0.0:9042
> ```

---

### Step 4: Start the DM service

```bash
npm run dev:dms
```

On first boot the service will:
1. Connect with a temporary client to create the `dms` keyspace
2. Connect the main client and create all 4 tables
3. Start listening on port 3007

Expected output:
```
[dms] Redis connected
DMS service running on port 3007
```

---

### Step 5: Verify

Hit the health endpoint:
```
GET http://localhost:3007/health
```

Expected response:
```json
{ "status": "ok", "service": "dms-service" }
```

---

## Inspecting Cassandra Directly

To open a CQL shell inside the running container:
```bash
docker exec -it discord-clone-cassandra cqlsh
```

Useful commands:
```cql
-- List keyspaces
DESCRIBE KEYSPACES;

-- Switch to DM keyspace
USE dms;

-- List tables
DESCRIBE TABLES;

-- Inspect a table
DESCRIBE TABLE messages_by_conversation;

-- Query data
SELECT * FROM conversations LIMIT 10;
```

To reset the keyspace entirely during development (wipes all DM data):
```cql
DROP KEYSPACE dms;
EXIT;
```
Then restart `npm run dev:dms` — tables will be recreated automatically.

---

## What Is Still In Progress

- **Chunk 5:** Edit message (`PATCH /dms/:id/messages/:msgId`) and delete message (`DELETE /dms/:id/messages/:msgId`)
- **Chunk 6:** Realtime integration — Redis pub/sub between DM service and realtime WebSocket service
- **Chunk 7:** Frontend API layer (`frontend/src/api/dms.ts`)
- **Chunk 8:** Frontend UI components (DmList, DmChatView, CreateDmModal)
- **Chunk 9:** Frontend realtime handlers
- **Chunk 10:** End-to-end testing
