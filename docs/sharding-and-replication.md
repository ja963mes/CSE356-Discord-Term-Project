# Sharding and replication

This document describes **how we partition data today** (Cassandra channel messages) and **design intent** for future PostgreSQL sharding when communities are spread across instances.

## Channel messages (Cassandra) — implemented

The messages service **writes and reads guild channel history** from Cassandra, not PostgreSQL.

| Concept | In this repo |
|--------|----------------|
| **Partition key** | `channel_id` — all messages for a channel live in one Cassandra partition (ordered by `created_at` timeuuid, descending). |
| **Replication** | Keyspace replication is configured via env: **`CASSANDRA_TOPOLOGY`** (`simple` → `SimpleStrategy`, `network` → `NetworkTopologyStrategy`) and **`CASSANDRA_REPLICATION_FACTOR`**. For multi-datacenter clusters, set `network` and **`CASSANDRA_LOCAL_DATACENTER`** to match the DC name of the nodes you connect to. |
| **Read/write tuning** | **`CASSANDRA_READ_CONSISTENCY`** / **`CASSANDRA_WRITE_CONSISTENCY`** (e.g. `localQuorum` writes, `localOne` reads) trade latency vs durability. |
| **Routing hints (HTTP)** | Responses from `GET/POST /messages` include **`X-Partition-Key`** (channel id), **`X-Shard-Key-Community`** (guild id for correlation), **`X-Storage-Keyspace`**, and **`X-Cassandra-Replication`** (topology + RF + DC). |

**Pagination:** `before` accepts a **timeuuid** string (or ISO timestamp parsed to a timeuuid) for “older than this” page.

Postgres still holds **`channels`**, **`channel_members`**, and **`community_members`**; the service enforces ACL before touching Cassandra.

## Future: PostgreSQL sharding (not implemented)

The following captures **design intent** for a time when PostgreSQL is **sharded** so communities are spread across instances.

## Goals

- **Scale guild-scoped data** (channels, membership, messages per community) without a single monolithic database.
- **Keep hot paths single-shard**: open guild → list channels → read history should not require distributed transactions.
- **Keep identity global**: users log in once; sessions are not tied to a community shard.

## Shard key: **community (guild)**

Route all **per-community** data by **`community_id`** (or a deterministic `shard_id` derived from it).

That keeps “everything for this server” on one shard: channels, `channel_members`, community-scoped messages, etc.

## The hard part: users span many communities

`users` and authentication are **global**. A user can belong to many guilds that end up on **different** shards.

Typical patterns:

| Approach | Idea |
|----------|------|
| **Global routing table** | Small store: `user_id → [(community_id, shard_hint)]` or similar. “List my servers” is one query (or a few partitions), not scatter-gather across every shard. |
| **Fan-out reads** | Ask each shard “which guilds is this user in?” — expensive at scale; usually avoided for the main sidebar. |
| **Hybrid** | Global index for “my guilds”; heavy data stays on community shards. |

**Design APIs** so that:

1. **Listing guilds** (sidebar) may hit a global index or a dedicated small service.
2. **Everything inside a guild** (given `community_id`) stays on **one** shard once routing is resolved.

## Replication vs sharding

- **Replication** = copies of the same data (HA, read scaling). **Sharding** = different subsets of data on different nodes.
- Use **read replicas** per shard for read-heavy workloads (e.g. message history).
- Be explicit about **async replication lag** (affects “read your own write.”).
- **Writes** usually go to one primary per shard unless you adopt a distributed SQL engine with different tradeoffs.

## What to bake in now (before sharding)

- **Stable keys**: `community_id` / `channel_id` on all relevant rows; avoid implicit cross-community joins in core flows.
- **No cross-community transactions** in business logic.
- **Idempotent** mutations where possible.
- **Directory search** (`/search-communities`): may evolve into a **global index** (Elasticsearch, or a small indexed table) fed by events, not a full scan of all shards.
- **Events** (outbox / queue): community lifecycle events can feed a future **shard router** or **search indexer** without ad hoc DB scans.

## Routing layer (later)

Something must map **`community_id` → shard connection** (or pool):

- a **routing service**,
- **consistent hashing** on `community_id` if shards are homogeneous.

Session cookies can stay **global** (e.g. Redis cluster); after auth, resolve **`community_id`** from the request path and connect to the right shard for guild work.

## DMs (Cassandra)

Direct messages are **not** community-sharded; they use a **separate** partitioning model (e.g. by conversation id). Keep that boundary clear so community sharding does not pull DM data into Postgres shards.

## Search (today vs eventual splintering)

**What exists now**

- **`search-service` (port 3004)** exposes `GET /search` as a **stub** (hardcoded placeholder results). The wireframe UI calls it via `search()` in `frontend/src/api/discord.ts` and **falls back** to sample text if the service is down.
- **Public guild directory search** is **not** implemented in `search-service`. It lives on the **communities** microservice as **`GET /search-communities`** (PostgreSQL-backed), separate from the global `/search` route.
- **Elasticsearch** appears in `docker-compose.yml` for a future indexing path; it is **not** wired into the Node search stub in this repo yet.

**Direction if we need real search**

Do **not** assume a single monolithic search service forever. At scale, retrieval is likely **splintered by domain** so each microservice that owns data also owns (or co-locates) **how that data is searched**:

| Domain (examples) | Natural owner for search/read APIs |
|-------------------|-------------------------------------|
| Guild channel message bodies | Messages service (+ Cassandra / future index) |
| DM message bodies | DMs service (+ Cassandra / future index) |
| Public community directory | Communities (already separate path) or a small global index fed by events |

That keeps **ACL, partitioning, and indexes** aligned with the same service boundary (e.g. DM search stays with DMs). If the product still wants **one unified search bar**, a thin **aggregator or BFF** can fan out to those domain endpoints—or the UX can offer **context-specific search** (search inside a guild, inside DMs, etc.) without a central search monolith.

This complements the earlier note that **`/search-communities`** may evolve into a **global index** fed by events rather than scanning shards.

## Summary

| Layer | Role |
|-------|------|
| **Shard key** | `community_id` for guild-scoped data |
| **Global** | Users, identities, sessions; index for “user → guilds” |
| **Per shard** | Channels, members, messages for communities on that shard |
| **Replication** | Per-shard replicas for reads and HA |
| **Channel messages (today)** | Cassandra `messages_by_channel` partitioned by `channel_id` |
| **DMs** | Separate keyspace / partitioning (Cassandra in this repo) |

Guild metadata can stay on Postgres while message bodies scale on Cassandra partitions. Future Postgres sharding would target channels and membership, not the Cassandra message store.
