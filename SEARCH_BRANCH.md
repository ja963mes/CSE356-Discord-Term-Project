# Search Branch — Full Documentation

## Table of Contents
1. [What Was Built](#what-was-built)
2. [Architecture Overview](#architecture-overview)
3. [How the Search Microservice Works](#how-the-search-microservice-works)
4. [Elasticsearch Index Design](#elasticsearch-index-design)
5. [Every File Changed or Created](#every-file-changed-or-created)
6. [Packages Installed](#packages-installed)
7. [Environment Variables](#environment-variables)
8. [How to Start Every Microservice](#how-to-start-every-microservice)
9. [API Reference](#api-reference)
10. [Backfill Script](#backfill-script)
11. [Testing Search](#testing-search)
12. [Bug Fixes Made](#bug-fixes-made)

---

## What Was Built

This branch implements **full-text message search** using **Elasticsearch** as a dedicated microservice (`services/search/`, port 3004). The service was previously a hardcoded stub returning fake data. It is now fully operational.

### Features implemented:
- Full-text search across **channel messages** inside a community
- Full-text search across **DM conversations** (1-to-1 and group)
- **Access control enforcement** at query time — private channel messages are hidden from users who are not members of that channel
- **Author filter** — narrow results to a specific user
- **Time range filter** — filter by `before` and `after` ISO timestamps
- **Highlights** — matched terms are wrapped in `<em>` tags in results
- **Newest-first** results ordering
- **Jump-to-context data** in every result (includes `scope_id`, `community_id`, `channel_name` etc.)
- **Real-time indexing** — messages are indexed within milliseconds of being posted via Redis pub/sub events
- **Edit propagation** — when a DM message is edited, the ES document is updated immediately
- **Delete propagation** — deleted messages are marked `is_deleted: true` and blank out from search
- **Conversation deletion** — when a DM conversation is hard-deleted (last member leaves), all its messages are purged from ES
- **Channel deletion** — when a channel is deleted from a community, all its indexed messages are purged from ES
- **Backfill script** — a one-time script to index all existing Cassandra messages into Elasticsearch

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client (Browser)                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP
                ┌──────────────▼──────────────┐
                │       Vite Dev Proxy         │
                │  /search → localhost:3004    │
                └──────────────┬──────────────┘
                               │
          ┌────────────────────▼────────────────────┐
          │           Search Service (3004)          │
          │                                          │
          │  ┌──────────────────────────────────┐   │
          │  │  GET /search/messages             │   │
          │  │  1. Verify session (Redis)        │   │
          │  │  2. ACL check (Postgres)          │   │
          │  │     - community_members           │   │
          │  │     - channel_members (per-user)  │   │
          │  │     - dm_participants             │   │
          │  │  3. Query Elasticsearch           │   │
          │  │  4. Return results + highlights   │   │
          │  └──────────────────────────────────┘   │
          │                                          │
          │  ┌──────────────────────────────────┐   │
          │  │  Redis Subscriber                │   │
          │  │  Listens to 3 channels:          │   │
          │  │  - channel:events                │   │
          │  │  - dm:events                     │   │
          │  │  - community:events              │   │
          │  └──────────────────────────────────┘   │
          └──────┬──────────────┬───────────────────┘
                 │              │
         ┌───────▼──────┐  ┌───▼─────────┐
         │  PostgreSQL  │  │Elasticsearch│
         │  (ACL only)  │  │  "messages" │
         │              │  │   index     │
         └──────────────┘  └─────────────┘

Event flow (real-time indexing):

messages-service (3003) ──POST /messages──► Cassandra (write)
                                         └──► Redis publish("channel:events")
                                                        │
dms-service (3007) ────POST /dms/:id/messages──► Cassandra
                                              └──► Redis publish("dm:events")
                                                        │
communities-service (3002) ─DELETE channel──► Redis publish("community:events")
                                                        │
                                          ┌─────────────▼──────────────┐
                                          │  Search Service Subscriber  │
                                          │  Receives all events and    │
                                          │  upserts/deletes in ES      │
                                          └─────────────────────────────┘
```

### Data stores used by the search service:
| Store | Purpose |
|---|---|
| **Elasticsearch** | Stores and searches message documents |
| **PostgreSQL** | ACL queries only (channel_members, community_members, dm_participants) |
| **Redis** | Session auth (read `session:<token>`) + event subscription |

The search service **never reads from Cassandra directly**. All message data flows through Redis events from the messages and DMs services.

---

## How the Search Microservice Works

### Startup sequence (`src/index.ts`)
1. Calls `ensureIndex()` — creates the `messages` ES index if it does not exist
2. Calls `startSubscriber()` — opens a dedicated Redis connection and subscribes to `channel:events`, `dm:events`, `community:events`
3. Starts the Express HTTP server on port 3004

### Real-time indexing flow (`src/subscriber.ts`)

The subscriber holds a **separate Redis connection** from the command client (required because a subscribed Redis connection cannot issue regular commands).

For every event received:

| Redis Channel | Event Type | Action |
|---|---|---|
| `channel:events` | `channel:message:create` | `indexMessage()` — upsert document with `scope_type: "channel"` |
| `dm:events` | `dm:message:create` | `indexMessage()` — upsert document with `scope_type: "dm"` |
| `dm:events` | `dm:message:edit` | `indexMessage()` — re-upsert with updated content |
| `dm:events` | `dm:message:delete` | `markDeleted()` — sets `is_deleted: true`, blanks content |
| `dm:events` | `dm:participant:leave` (with `conversationDeleted: true`) | `deleteByScope()` — removes all docs for that conversation |
| `community:events` | `community:channel:delete` | `deleteByScope()` — removes all docs for that channel |

The subscriber also maintains **two in-memory LRU caches** (5-minute TTL):
- `usernameCache` — maps `userId → username` to avoid Postgres hits on every DM message
- `channelNameCache` — maps `channelId → name` to denormalize channel names into documents

### Search query flow (`src/routes/search.ts`)

**Community scope:**
1. Validate session cookie via Redis
2. Verify caller is in `community_members` for the given `communityId`
3. Query `channel_members JOIN channels WHERE community_id = ? AND user_id = ?` to get all channel IDs the user can access (this naturally respects private channels — you only appear in `channel_members` for private channels if an admin explicitly added you)
4. Build ES `bool` query with `terms` filter on `scope_id: [channelIds]`
5. Apply optional `author_id` and `created_at` range filters
6. Sort `created_at` descending, return highlights

**DM scope:**
1. Validate session
2. Verify caller is in `dm_participants` for the given `conversationId`
3. Pass `[conversationId]` as the sole `scope_id`
4. Query ES with same filter structure

### Why access control is done at query time (not index time)

Channel memberships change frequently (join/leave community). Pre-computing and maintaining a denormalized access list in ES would require handling every `channel_members` change event. Instead, a single indexed Postgres join (`channel_members` + `channels`) returns all accessible channel IDs in one fast query, which is then passed as an ES `terms` filter. This is correct, simple, and efficient.

---

## Elasticsearch Index Design

**Index name:** `messages` (configurable via `ES_INDEX_NAME` env var)

### Mapping

```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0
  },
  "mappings": {
    "properties": {
      "message_id":      { "type": "keyword" },
      "scope_type":      { "type": "keyword" },
      "scope_id":        { "type": "keyword" },
      "community_id":    { "type": "keyword" },
      "channel_name":    { "type": "keyword" },
      "author_id":       { "type": "keyword" },
      "author_username": { "type": "keyword" },
      "content":         { "type": "text"    },
      "created_at":      { "type": "date"    },
      "updated_at":      { "type": "date"    },
      "is_deleted":      { "type": "boolean" }
    }
  }
}
```

### Field explanations

| Field | Type | Description |
|---|---|---|
| `message_id` | keyword | Document `_id` — UUID of the message. Used as the ES document ID so all upserts are idempotent. |
| `scope_type` | keyword | `"channel"` or `"dm"` — discriminates the two message types |
| `scope_id` | keyword | The `channel_id` for channel messages, or `conversation_id` for DMs. This is the primary filter used during search. |
| `community_id` | keyword | UUID of the community for channel messages; `null` for DMs |
| `channel_name` | keyword | Denormalized channel name for display in results (avoids a join at query time) |
| `author_id` | keyword | UUID of the message author — used for author filter |
| `author_username` | keyword | Denormalized username for display in results |
| `content` | text | The full message text — **this is the field that is full-text searched** |
| `created_at` | date | ISO timestamp — used for time range filters and sort (newest first) |
| `updated_at` | date | ISO timestamp of last edit; `null` if never edited |
| `is_deleted` | boolean | Soft-delete flag; deleted messages are always filtered out from results |

### Why a single unified index

Using one index for both channel messages and DMs keeps queries simple and requires only one mapping. The `scope_type` + `scope_id` discriminator fields handle routing. Separate indices would only be justified at much larger scale.

---

## Every File Changed or Created

### Files Created (11 new files)

#### `services/messages/src/events.ts` *(NEW)*
Publishes channel message events to Redis `channel:events` pub/sub channel. Follows the same pattern as `services/dms/src/events.ts`. This was the **critical missing piece** — the messages service had no event system, so new channel messages were never indexed.

```
Event type published: channel:message:create
  channelId, communityId, message: { messageId, authorId, authorUsername, content, createdAt }
```

---

#### `services/search/src/env.ts` *(NEW)*
Zod-validated environment schema for the search service. Loads from the monorepo root `.env` file.

```typescript
SEARCH_PORT          // default "3004"
DATABASE_URL         // Postgres connection string
REDIS_URL            // Redis connection string
ELASTICSEARCH_URL    // default "http://localhost:9200"
ES_INDEX_NAME        // default "messages"
```

---

#### `services/search/src/redis.ts` *(NEW)*
ioredis client singleton for command operations (session lookups). A **second** Redis connection is created in `subscriber.ts` for pub/sub (Redis requires a dedicated connection for subscribing).

---

#### `services/search/src/db.ts` *(NEW)*
Drizzle ORM PostgreSQL pool connection. Used exclusively for access control queries (never for message storage).

---

#### `services/search/src/db/schema.ts` *(NEW)*
Read-only Drizzle table definitions. Contains only the tables needed for ACL enforcement:
- `users` — for username fallback lookups
- `communities` — for community existence
- `communityMembers` — to verify community membership
- `channels` — to join with channel_members
- `channelMembers` — to get accessible channel IDs per user
- `directConversations` — for DM conversation existence
- `dmParticipants` — to verify DM participation

Does **not** own any migrations. Shares the same Postgres database managed by the auth service.

---

#### `services/search/src/middleware/session.ts` *(NEW)*
Standard `requireAuth` middleware. Reads `session_token` cookie, looks up `session:<token>` in Redis, and sets `req.user.internal_id`. Identical pattern to all other services.

---

#### `services/search/src/types/express.d.ts` *(NEW)*
TypeScript ambient declaration that adds `user: { internal_id: string }` to Express `Request` interface.

---

#### `services/search/src/elasticsearch.ts` *(NEW)*
The core Elasticsearch module. Exports:

| Export | Description |
|---|---|
| `esClient` | Singleton `@elastic/elasticsearch` Client |
| `ensureIndex()` | Creates the `messages` index if it does not exist |
| `indexMessage(doc)` | Upserts a message document using `_id = message_id` |
| `markDeleted(messageId)` | Partial update: `is_deleted: true`, `content: ""` |
| `deleteByScope(scopeId)` | Delete-by-query: removes all docs with a given `scope_id` |
| `searchMessages(params)` | Builds and executes the full bool query |

The `searchMessages` function builds:
```
bool.must:   [match(content, query, fuzziness=AUTO)]
bool.filter: [terms(scope_id, scopeIds), term(is_deleted, false),
              optional: term(author_id), range(created_at)]
sort:        [created_at DESC]
highlight:   content field, fragment_size=200
```

---

#### `services/search/src/subscriber.ts` *(NEW)*
Redis pub/sub subscriber. Subscribes to three channels:
- `channel:events` — new channel messages from messages service
- `dm:events` — DM create/edit/delete from dms service
- `community:events` — channel deletion from communities service

Includes two in-memory caches (5-min TTL) for username and channel name lookups to avoid database calls on every event.

---

#### `services/search/src/routes/search.ts` *(NEW)*
Express router exposing `GET /search/messages` with full access control logic. See [API Reference](#api-reference) for full details.

---

#### `scripts/es-backfill.ts` *(NEW)*
One-time script that reads all existing messages from Cassandra and bulk-indexes them into Elasticsearch. Handles:
- Missing keyspaces gracefully (skips rather than crashing)
- Missing `direct_conversations` table gracefully (skips DMs)
- Pre-loads all usernames from Postgres into memory
- Uses ES `_bulk` API in 500-document batches for throughput
- Fully idempotent — safe to run multiple times (upserts by `message_id`)

---

### Files Modified (6 existing files changed)

#### `services/search/src/index.ts` *(REWRITTEN)*
Previously: A 27-line hardcoded stub returning fake data.
Now: A full service that initializes Elasticsearch, starts the Redis subscriber, mounts auth middleware and the search router, then listens on port 3004.

---

#### `services/search/package.json` *(MODIFIED)*
Added production dependencies:
```
@elastic/elasticsearch  ^8.13.1
cookie-parser           ^1.4.7
drizzle-orm             ^0.44.2
ioredis                 ^5.6.1
pg                      ^8.16.0
zod                     ^3.25.42
```
Added dev dependencies:
```
@types/cookie-parser  ^1.4.8
@types/pg             ^8.15.4
```

---

#### `services/messages/src/index.ts` *(MODIFIED)*
Two changes:
1. Added import: `import { publishChannelEvent } from "./events"`
2. In the `POST /messages` handler, after `insertChannelMessage()` succeeds, added a fire-and-forget event publish:
```typescript
void publishChannelEvent({
  type: "channel:message:create",
  channelId,
  communityId: access.channel.community_id,
  message: { messageId, authorId: userId, authorUsername, content, createdAt: ts },
});
```
`void` matches the existing pattern used throughout the project (fire-and-forget; HTTP response is not delayed).

---

#### `services/messages/src/env.ts` *(MODIFIED)*
Renamed `PORT` → `MESSAGES_PORT` (default `"3003"`).

**Why:** The root `.env` file sets `PORT=3001` (for the auth service). All services that use the generic `PORT` variable were starting on port 3001 and colliding with auth. This follows the existing pattern: `COMMUNITIES_PORT=3002`, `DMS_PORT=3007`, etc.

---

#### `services/dms/src/events.ts` *(MODIFIED)*
Added `authorUsername: string` field to the `dm:message:create` event type's `message` object.
Added `authorUsername: string` field to the `dm:message:edit` event type's `message` object.

This allows the search subscriber to index the author's display name without a Postgres lookup on every DM message.

---

#### `services/dms/src/dm/service.ts` *(MODIFIED)*
Three changes:
1. Added `users` to the Drizzle imports from `pgSchema`
2. Added a `lookupUsername(userId)` helper function that queries `users` by `internal_id` and caches the result in memory
3. In `createMessage()`: calls `lookupUsername(params.authorId)` and includes `authorUsername` in the `dm:message:create` event payload
4. In `editMessage()`: same — includes `authorUsername` in the `dm:message:edit` event payload

---

#### `package.json` (root) *(MODIFIED)*
Added script:
```json
"es:backfill": "tsx scripts/es-backfill.ts"
```

---

## Packages Installed

Run `npm install` at the repo root after pulling this branch.

### New packages added to `services/search/package.json`

| Package | Version | Purpose |
|---|---|---|
| `@elastic/elasticsearch` | ^8.13.1 | Official Elasticsearch Node.js client |
| `cookie-parser` | ^1.4.7 | Parses session_token cookie on requests |
| `drizzle-orm` | ^0.44.2 | PostgreSQL ORM for ACL queries |
| `ioredis` | ^5.6.1 | Redis client for sessions + pub/sub |
| `pg` | ^8.16.0 | PostgreSQL driver |
| `zod` | ^3.25.42 | Runtime environment variable validation |
| `@types/cookie-parser` | ^1.4.8 | TypeScript types |
| `@types/pg` | ^8.15.4 | TypeScript types |

### Already present in other services / root (no change needed)
`dotenv`, `express`, `typescript`, `ts-node`, `nodemon` — already hoisted from root workspace.

---

## Environment Variables

All variables are loaded from the **monorepo root `.env`** file (located at the repo root, not inside the service directory). The search service reads `../../../.env` relative to its `src/` directory.

### Required (must be in `.env`)
```env
DATABASE_URL=postgresql://postgres:password@localhost:5433/auth_db
REDIS_URL=redis://localhost:6379
```

### Optional (have defaults)
```env
SEARCH_PORT=3004              # Port the search service listens on
ELASTICSEARCH_URL=http://localhost:9200   # Elasticsearch node URL
ES_INDEX_NAME=messages        # Name of the ES index
```

### Full `.env.example` additions (already present since before this branch)
```env
ELASTICSEARCH_URL=http://localhost:9200
```

---

## How to Start Every Microservice

### Prerequisites

1. **Docker Desktop** must be running
2. Start all infrastructure (Postgres, Redis, Cassandra, Elasticsearch):
   ```bash
   docker compose up -d
   ```
3. Wait ~30-60 seconds for Cassandra to fully initialize. Verify:
   ```bash
   docker exec discord-clone-cassandra cqlsh -e "SELECT release_version FROM system.local"
   ```
4. Run database migrations (only needed on first run or after schema changes):
   ```bash
   npm run db:migrate
   ```
5. Install dependencies:
   ```bash
   npm install
   ```

### Starting all services together (recommended for development)
```bash
npm run dev:all
```
This starts all 7 services + the frontend concurrently using `concurrently`.

### Starting individual services
```bash
npm run dev:auth            # Auth service           → http://localhost:3001
npm run dev:communities     # Communities service    → http://localhost:3002
npm run dev:messages        # Messages service       → http://localhost:3003
npm run dev:search          # Search service         → http://localhost:3004
npm run dev:create-community # Create-community service → http://localhost:3006
npm run dev:dms             # DMs service            → http://localhost:3007
npm run dev:frontend        # React frontend         → http://localhost:5173
```

### Confirming services are healthy
```bash
curl http://localhost:3001/health  # {"status":"ok","service":"auth-service"}
curl http://localhost:3002/health  # {"status":"ok","service":"communities-service"}
curl http://localhost:3003/health  # {"status":"ok","service":"messages-service","storage":"cassandra"}
curl http://localhost:3004/health  # {"status":"ok","service":"search-service","elasticsearch":"connected"}
curl http://localhost:3006/health  # {"status":"ok","service":"create-community-service"}
curl http://localhost:3007/health  # {"status":"ok","service":"dms-service"}
```

### Starting the backfill (to index existing messages)
```bash
npm run es:backfill
```
Run this once after infrastructure is up and services have been started at least once (so Cassandra keyspaces are initialized). The script is idempotent — safe to run multiple times.

### Minimal setup for developing search only
If you only want to work on search and don't want to run everything locally, you can run the hybrid dev mode which uses the staging server for auth/communities and runs messages/search/dms locally:
```bash
npm run dev:hybrid
```

Or search + frontend only (no Cassandra):
```bash
npm run dev:hybrid:no-cassandra
```

---

## API Reference

### `GET /health`
Returns the search service status and Elasticsearch connectivity.

**Response:**
```json
{ "status": "ok", "service": "search-service", "elasticsearch": "connected" }
```
Returns `503` with `"elasticsearch": "disconnected"` if ES is unreachable.

---

### `GET /search/messages`
Search messages. Requires authentication (session cookie).

**Query Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Full-text search query. Supports fuzzy matching. |
| `scope` | `"community"` or `"dm"` | Yes | What to search within |
| `communityId` | UUID | When `scope=community` | ID of the community to search |
| `conversationId` | UUID | When `scope=dm` | ID of the DM conversation to search |
| `authorId` | UUID | No | Filter results to messages by a specific author |
| `before` | ISO 8601 date | No | Only return messages before this timestamp |
| `after` | ISO 8601 date | No | Only return messages after this timestamp |
| `limit` | integer 1–50 | No | Number of results to return. Default: 25 |
| `offset` | integer ≥ 0 | No | Pagination offset. Default: 0 |

**Success Response (200):**
```json
{
  "query": "hello",
  "total": 2,
  "results": [
    {
      "message_id": "68fcb16e-2fc1-4770-b96a-8a8b4e457013",
      "scope_type": "channel",
      "scope_id": "c35d2002-3d39-475b-afa9-d58e7fed5044",
      "community_id": "ff65edc5-88fc-4440-80d2-544fbbe0da6b",
      "channel_name": "general",
      "author_id": "5eef0df1-2078-4aee-9bed-0034f3c0b9f1",
      "author_username": "searchtest",
      "content": "hello world this is a test message",
      "created_at": "2026-04-02T03:27:31.834Z",
      "highlight": "<em>hello</em> world this is a test message"
    }
  ]
}
```

For DM messages, `community_id` and `channel_name` are `null`.

**Error Responses:**

| Status | Condition |
|---|---|
| `400` | Missing or invalid parameters |
| `401` | Not authenticated (no session cookie) |
| `403` | Not a member of the community / not a participant in the DM |

**Usage examples:**

```bash
# Search community messages
curl -b cookies.txt "http://localhost:3004/search/messages?q=hello&scope=community&communityId=<uuid>"

# Search DM conversation
curl -b cookies.txt "http://localhost:3004/search/messages?q=hello&scope=dm&conversationId=<uuid>"

# Filter by author
curl -b cookies.txt "http://localhost:3004/search/messages?q=message&scope=community&communityId=<uuid>&authorId=<uuid>"

# Filter by time range
curl -b cookies.txt "http://localhost:3004/search/messages?q=hello&scope=community&communityId=<uuid>&after=2026-01-01T00:00:00Z&before=2026-12-31T23:59:59Z"

# Paginate results
curl -b cookies.txt "http://localhost:3004/search/messages?q=hello&scope=community&communityId=<uuid>&limit=10&offset=20"
```

---

## Backfill Script

Located at `scripts/es-backfill.ts`. Run with:
```bash
npm run es:backfill
```

### What it does:
1. Connects to Postgres, Elasticsearch, and both Cassandra keyspaces
2. Pre-loads all users (`internal_id → username`) from Postgres into a Map
3. Pre-loads all channels (`id → { communityId, name }`) from Postgres
4. Pre-loads all DM conversation IDs from Postgres
5. For each channel: fetches all messages from Cassandra `messaging.messages_by_channel` and bulk-indexes to ES
6. For each DM conversation: fetches all messages from Cassandra `dms.messages_by_conversation` and bulk-indexes to ES
7. Uses the ES `_bulk` API in 500-document batches for throughput

### Resilience:
- If the `messaging` Cassandra keyspace does not exist (messages service never started), it skips channel messages gracefully
- If the `dms` Cassandra keyspace does not exist, it skips DM messages gracefully
- If the `direct_conversations` Postgres table does not exist (migrations not run), it skips DMs gracefully
- Fully **idempotent** — each document is upserted by `message_id`, so running it multiple times is safe

---

## Testing Search

### Quick test (after all services are running)

```bash
# 1. Register and login
curl -c cookies.txt -X POST http://localhost:3001/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"pass123","email":"test@test.com"}'

curl -c cookies.txt -X POST http://localhost:3001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"pass123"}'

# 2. Create a community (note the community id from the response)
curl -b cookies.txt -X POST http://localhost:3006/create-community \
  -H "Content-Type: application/json" \
  -d '{"name":"TestGuild"}'

# 3. Get the #general channel id
curl -b cookies.txt http://localhost:3002/communities/<communityId>/channels

# 4. Post a message
curl -b cookies.txt -X POST http://localhost:3003/messages \
  -H "Content-Type: application/json" \
  -d '{"channelId":"<channelId>","content":"hello world elasticsearch"}'

# 5. Search (messages are indexed near-instantly)
curl -b cookies.txt "http://localhost:3004/search/messages?q=hello&scope=community&communityId=<communityId>"
```

### What was verified in final test session

| Test | Expectation | Result |
|---|---|---|
| Search `hello` in community | 1 result with `<em>hello</em>` highlight | ✅ Pass |
| Search `elasticsearch` in community | 1 result with correct highlight | ✅ Pass |
| Search `bananas` in community | 1 result | ✅ Pass |
| Search `message` in community | 2 results, newest first | ✅ Pass |
| Search non-existent term `xyzzy123nothere` | `total: 0, results: []` | ✅ Pass |
| DM search `hello` | 2 results from both participants | ✅ Pass |
| DM search `reply` | 1 result from user2 only | ✅ Pass |
| Author filter (`authorId=user1`) | Only user1 messages | ✅ Pass |
| Non-member searches community | `403 Forbidden` | ✅ Pass |
| User joins community, searches | Results returned | ✅ Pass |
| Private channel: user1 (member) searches | Finds private message | ✅ Pass |
| Private channel: user2 (non-member) searches same community | `total: 0` — private message hidden | ✅ Pass |

---

## Bug Fixes Made

### Port collision: messages and search services starting on port 3001

**Problem:** The root `.env` file contains `PORT=3001` (intended for the auth service). The messages service (`services/messages/src/env.ts`) and the original search service stub both declared their port env var as `PORT`, which caused them to read `3001` from the root `.env` and collide with the auth service on startup.

**Fix:** Renamed the port env var in both services to follow the established project pattern:
- `services/messages/src/env.ts`: `PORT` → `MESSAGES_PORT` (default `"3003"`)
- `services/search/src/env.ts`: `PORT` → `SEARCH_PORT` (default `"3004"`)
- Updated `services/messages/src/index.ts` and `services/search/src/index.ts` to read `env.MESSAGES_PORT` and `env.SEARCH_PORT` respectively

No `.env` file changes are needed — both services default to their correct ports when the specific variable is absent.
