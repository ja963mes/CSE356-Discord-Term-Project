# Scaling and Load Handling

Companion to README §3. This doc walks through each bottleneck we identified during load testing, the evidence we used, the change we shipped, and what remains.

| Bottleneck | Evidence | Fix | Result |
|------------|----------|-----|--------|
| [Redis VM CPU saturation](#1-redis-vm-cpu-saturation) | `INFO commandstats`, `--bigkeys`, `SLOWLOG` | In-memory SMEMBERS cache + `SCAN` → set index + 4→8 vCPU | ~100× drop in SMEMBERS QPS, slowlog cleared |
| [DM delivery timeouts](#2-dm-delivery-timeouts) | autograder errors, ws.send queue depth | Pubsub sharding, per-socket queue, sync eviction, replay | Timeouts stopped reproducing |
| [Postgres connection pressure](#3-postgres-connection-pressure) | `pg_stat_activity`, clustered worker count | PgBouncer + per-service pool sizing | Connection count bounded |
| [Cassandra read amplification on read-state](#4-cassandra-read-amplification-on-read-state) | service logs, RT span | `rs:*` Redis read-through cache | ~5× drop in Cassandra reads |
| [Realtime fan-out cost](#5-realtime-fan-out-cost) | per-event SMEMBERS calls | 2 s membership cache + inflight dedupe | One Redis call per hot key per 2 s |

The single biggest issue was Redis; the rest are smaller. Each section gives the data we measured and the rationale, not just "we changed code."

---

## 1. Redis VM CPU saturation

### Symptom

Under autograder load, WebSocket fan-out latency spiked into the hundreds of ms, and the autograder reported `Delivery timeout` on a fraction of DMs. Aggregate VM CPU on the Redis VM (originally 4 vCPU) showed only ~40% utilisation, masking the true cause: each `redis-server` is single-threaded, so one hot instance can saturate one core while leaving the other three idle.

### Evidence

We ran the standard Redis triage on each port (`6379`, `6380`, `6381`, `6382`):

```bash
redis-cli -p 6382 INFO commandstats | sort -t= -k2 -n -r | head -20
# cmdstat_smembers:calls=320871,usec=117441321,usec_per_call=366.01
# cmdstat_sadd:calls=25474,usec=51930,usec_per_call=2.04
# cmdstat_scan:calls=1617,usec=220399,usec_per_call=136.30
```

`SMEMBERS` consumed 117 s of CPU on the kv-cache instance — the single largest line item.

```bash
redis-cli -p 6382 --bigkeys
# Biggest set found "presence:channel:c86ce7c2-d7bc-4232-85d0-a0c583bde855"
#   has 1521 members
# 91% of keys are sets (4713/5158)
```

A single channel set held 1521 members.

```bash
redis-cli -p 6382 SLOWLOG GET 20
# Repeated entries:
#  smembers presence:channel:c86ce7c2-... (10ms, 24ms, 47ms, 68ms, 160ms)
#  scan 0 MATCH presence:conns:* COUNT 200 (13ms, 19ms)
```

Slowlog confirmed the hot key was re-read on every event. `SCAN` showed up too, but with 1 617 calls vs 320 871 for SMEMBERS, it was a smaller fish.

The grep that pinned the call site:

```text
services/realtime/src/index.ts:542  fanOutToChannel  → SMEMBERS presence:channel:<id>
services/realtime/src/index.ts:1213 channel:message:create handler → SMEMBERS presence:channel:<id>
services/realtime/src/index.ts:531  fanOutToGuild    → SMEMBERS presence:guild:<id>
```

Three call sites, all running per-event.

### Change

**a. In-memory TTL cache for membership sets.** `services/realtime/src/index.ts`:

```ts
const PRESENCE_SET_TTL_MS = 2000;
type PresenceSetEntry = { members: string[]; expiresAt: number; inflight?: Promise<string[]> };
const presenceChannelMembersCache = new Map<string, PresenceSetEntry>();

async function getPresenceChannelMembers(channelId: string): Promise<string[]> {
  return getCachedSmembers(presenceChannelMembersCache, channelId, `presence:channel:${channelId}`);
}
```

`getCachedSmembers` keys on the channel/guild id, returns cached members if fresh, returns the inflight promise if a fetch is already in progress (thundering-herd protection), and only calls `kvCacheRedis.smembers` once per 2 s per hot key.

The three call sites were rewritten to call `getPresenceChannelMembers` / `getPresenceGuildMembers` instead of `kvCacheRedis.smembers` directly.

**b. `presence:conns:index` set replaces `SCAN MATCH`.** `services/realtime/src/presence.ts`:

```ts
export const PRESENCE_CONNS_INDEX = "presence:conns:index";

export async function registerConnection(redis, userId, connId, instanceId): Promise<void> {
  await redis.multi()
    .hset(`presence:conns:${userId}`, `${instanceId}:${connId}`, 0)
    .sadd(PRESENCE_CONNS_INDEX, userId)
    .exec();
}

export async function removeConnection(redis, userId, connId, instanceId): Promise<void> {
  const key = `presence:conns:${userId}`;
  const result = await redis.multi().hdel(key, `${instanceId}:${connId}`).hlen(key).exec();
  const remaining = (result?.[1]?.[1] as number) ?? 0;
  if (remaining === 0) {
    await redis.multi().del(key).srem(PRESENCE_CONNS_INDEX, userId).exec();
  }
}
```

Both startup cleanup and the periodic stale-instance reaper now do `SMEMBERS PRESENCE_CONNS_INDEX` instead of `SCAN MATCH presence:conns:*`. The reaper also self-heals empty hashes by `SREM`ing them — recovers from crash-loop residue without a manual sweep.

**c. Vertical scale + headroom.** Redis VM resized 4 vCPU → 8 vCPU. The four existing single-thread instances continue using four cores; four spare cores are reserved for additional instances (`presence:6383`, etc.) if hot-key isolation is needed in a future round.

**d. Operational visibility.** Wired Zabbix agent2's built-in Redis plugin in `ansible/roles/zabbix-agent/`. Each port is a session (`pubsub`, `pubsub2`, `kv`, `kv2`) polled via `redis.info[<section>,<session>]`. Triggers in [docs/zabbix-redis-monitoring.md](./zabbix-redis-monitoring.md):

- per-port memory > 80 % of `maxmemory` (warning) / > 95 % (disaster on `noeviction` ports)
- per-port slowlog growth > 5/min (warning) — catches the next SMEMBERS-class regression *before* user impact
- `discord.redis.proc[<port>]` UserParameter alarms on per-port process death
- VM-level CPU/load triggers as a backstop, but the per-port triggers fire first under hot-key load.

### Why these worked

Redis is single-threaded per process. A 30 ms `SMEMBERS` blocks every other client for 30 ms. The two largest CPU lines on `kv2` (SMEMBERS at 117 s and SCAN at 0.22 s) both came from realtime fan-out paths reading the same data on every event. Caching coalesces those reads into one round-trip per hot key per TTL window. Replacing `SCAN MATCH` with a maintained set avoids walking the keyspace at all.

### Tradeoffs

- **2 s membership lag.** A user joining a channel while a message is being fanned out could miss it for at most 2 s. Acceptable: presence membership is regenerated on the next event and `presence:channel:*` is by definition only "currently online + subscribed", which is already eventually consistent.
- **Inflight dedupe relies on the same Node process.** Across the two realtime instances, both will fetch independently — that's fine, two reads is not the bottleneck.
- **Single Redis VM is still SPOF.** No replicas, no Sentinel. We chose to defer this:
  - Redis Cluster requires sharded pubsub semantics (`SPUBLISH`/`SSUBSCRIBE`) and breaks multi-key ops; both touch our hot path.
  - The per-port split absorbed the observed load, leaving cluster-grade complexity for after the course.
  - HA could come first via a single read-replica + manual failover, but at this scale it adds operational surface without solving an active problem.
- **`pubsub2` and `kv2` are deployed but not yet client-routed.** Service code still hits `:6379` and `:6380` only. Wiring `crc16(key) % 2` style routing in each service's `redis.ts` is the cheapest next scaling step.

---

## 2. DM delivery timeouts

### Symptom

Autograder DM tests reported intermittent `Delivery timeout` errors when many concurrent users sent DMs at once.

### Evidence

- Realtime logs showed bursts of `ws.send` callbacks queued behind a single hot DM target (one user receiving from many).
- A `repro-closing-socket-race.ts` script (`services/dms/scripts/`) reproduced the failure: when a client lost network connectivity, the WebSocket sat in CLOSE_WAIT for ~25 s before the heartbeat noticed, during which `ws.send` calls succeeded synchronously but messages never reached the wire.
- Re-tests with the test harness (`npm run test:trace`) showed double-delivery when both pubsub and direct-HTTP fanout paths fired.

### Change

Layered fixes — full table in [docs/IMPLEMENTATION.md](./IMPLEMENTATION.md#dm-delivery-reliability).

| Layer | Change |
|-------|--------|
| pub-sub fanout | `dm:userfeed:{0..19}` shards keyed by userId; each realtime instance subscribes all 20 shards but only delivers to local users |
| per-socket queue | In-process queue drained via `setImmediate`; kill on >512 messages or 1 MB buffered |
| dead socket | `ws.send` failure → synchronous eviction from local maps before the close handler runs |
| reconnect | `disconnectedAt`-based Cassandra range query replaces per-conversation cursor (1 read per conversation instead of 2) |
| dedup | Last 512 message IDs per connection block double-delivery from the parallel pub-sub + direct-HTTP paths |
| publish retry | DMs service retries publish 3× with 50 ms / 100 ms backoff |
| pending queue | `dm:pending:<userId>` (list, cap 100, TTL 2 h) bridges the reconnect gap |

### Why these worked

Each layer addresses a distinct failure mode:

- Pubsub sharding bounds per-instance fanout cost. Without it, every realtime instance handles every DM, even those for users connected elsewhere.
- The per-socket queue + sync eviction kills the head-of-line blocking caused by a single slow socket.
- Cassandra replay + pending queue close the reconnect gap that was eating messages.
- Dedup prevents the user from receiving the same message twice when both delivery paths succeed.

### Tradeoffs

- More network traffic — each DM publishes to one of 20 channels but realtime instances subscribe all 20.
- Server-side dedup state (512 IDs) is per-connection; survives across reconnects only via the pending-queue replay, not via the dedup set itself.

---

## 3. Postgres connection pressure

### Symptom

Early load tests hit `FATAL: too many connections` on the Postgres VM when all clustered Node workers came online at once.

### Evidence

- `pg_stat_activity` showed > 100 idle connections per service VM under steady-state load.
- Each clustered service forked one worker per CPU core; each worker held its own pool. 7 services × 2–4 workers × 10-conn pool ≈ 100+ connections.

### Change

- **PgBouncer in front of Postgres** on the backend VM. Apps connect to `pgbouncer:6432`; migrations connect direct to `postgres:5433`.
- **Reduced per-service pool sizes** (`PG_POOL_MAX=10`) — the bouncer multiplexes.
- **`DATABASE_URL` vs `DATABASE_URL_DIRECT`** — every service reads the bouncer URL for runtime; only `npm run db:migrate` uses the direct URL.

### Why it worked

PgBouncer in transaction mode shares a small pool of real Postgres connections among many client connections. Connection count to Postgres became a function of *active queries*, not *worker processes*.

### Tradeoffs

- Transaction-mode PgBouncer disables session-scoped features (advisory locks, prepared statements). We don't use them.
- One more service to monitor.

---

## 4. Cassandra read amplification on read-state

### Symptom

Read-state queries (unread counts, last-read pointers) hit Cassandra on every WebSocket reconnect and every channel switch. Per-user actions caused per-channel reads.

### Evidence

- read-state service logs showed Cassandra queries per channel-membership row, multiplied by every user-channel intersection.
- Per-request span: > 5 Cassandra reads per `GET /read-state` for a user in 5 channels.

### Change

- **Read-through cache** in `kv2`: `rs:latest:ch:*`, `rs:cs:<user>:<channel>`, `rs:ds:<user>:<conv>`, `rs:mc:<user>:<channel>`.
- **Write-through invalidation** — message writes on the messages service write `rs:latest:ch:*` directly so reads can skip Cassandra entirely on the hot path.

### Why it worked

Read-state lookups are read-heavy and not strictly consistent (a 1-2 s lag in unread counts is invisible). Caching collapses the per-channel reads into a single Redis hit.

### Tradeoffs

- Adds load to `kv2` — partly the cause of §1 above. Splitting `presence:*` to its own port (future) frees `kv2` for read-state.

---

## 5. Realtime fan-out cost

This is essentially §1 from a different angle. The fan-out functions `fanOutToChannel`, `fanOutToGuild`, and the `channel:message:create` handler each called `kvCacheRedis.smembers` once per event. At 320k SMEMBERS/test-window, that was the dominant CPU consumer on `kv2`.

The 2 s in-memory cache (§1.a) collapses these to one Redis call per hot key per TTL window.

### Why a 2 s TTL

- WebSocket clients typing-indicators, message bursts, and presence updates all arrive within seconds of each other; cache hit rate at 2 s is > 95 % for hot channels.
- Lag of up to 2 s in *who's subscribed to a channel right now* is invisible at the UI level — presence is already eventually consistent.
- Beyond ~2 s, the freshness cost overtakes the SMEMBERS savings.

### Inflight dedupe

When the cache expires and a hot key is re-read, every concurrent fan-out for that channel would otherwise issue its own `SMEMBERS`. Storing the in-flight promise on the cache entry collapses N concurrent reads into one Redis round-trip.

---

## What we did not solve

- **No HA on Redis, Postgres, or Elasticsearch.** Single-primary; replicas designed but not deployed.
- **No durable async broker.** Redis pubsub is best-effort; Cassandra is the durable record.
- **No Postgres sharding.** Cassandra absorbs message-write scale; Postgres tables are small enough that sharding would be premature complexity. Design notes in [sharding-and-replication.md](./sharding-and-replication.md).
- **`pubsub2` / `kv2` not client-routed.** Provisioned, not wired. Cheapest next scaling step.

---

## How to triage future Redis hot spots

1. **`INFO commandstats | sort` on every port.** The top line by `usec` total is your bottleneck command.
2. **`--bigkeys`.** If a single key dominates the keyspace by size, you have a hot-key problem.
3. **`SLOWLOG GET 20`.** Confirms whether the bottleneck command is also slow per-call (long set, complex Lua) or just frequent.
4. **Locate the call site.** `grep -rn "kvCacheRedis\." services` is usually enough.
5. **Decide: cache or move.** If the data is read-heavy and tolerates lag, cache it in-process. If a single workload dominates, split it to its own port (`kv3:6383`, etc.) — rooms for four more on the 8-vCPU VM.
6. **Re-measure.** Same INFO commandstats sort 5 minutes after the deploy.

The Zabbix per-port slowlog trigger (configured in [zabbix-redis-monitoring.md](./zabbix-redis-monitoring.md)) is intended to alarm on this *before* user impact — a recurring slowlog growth means the next bottleneck is forming.
