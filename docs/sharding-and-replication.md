# Sharding and replication (future design)

This document captures **design intent** for a time when PostgreSQL (or other stores) are **sharded** and **replicated** so communities are spread across instances. Nothing here is implemented yet; it is guidance for schema and API boundaries.

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

## Summary

| Layer | Role |
|-------|------|
| **Shard key** | `community_id` for guild-scoped data |
| **Global** | Users, identities, sessions; index for “user → guilds” |
| **Per shard** | Channels, members, messages for communities on that shard |
| **Replication** | Per-shard replicas for reads and HA |
| **DMs** | Separate store / partitioning (Cassandra in this repo) |

This aligns with common Discord-style architectures and with a migration path from today’s single Postgres without a big-bang rewrite.
