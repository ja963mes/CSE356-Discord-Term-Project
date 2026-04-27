import Redis from "ioredis";
import { env } from "./env";

// Pubsub instance — publishes `dm:userfeed:*` shards, subscribes to `channel:events`.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[read-state] Redis (pubsub) connected"));
redis.on("error", (err) => console.error("[read-state] Redis (pubsub) error:", err));

// KV instance (port 6380) — sessions (`session:*`).
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => console.log("[read-state] Redis (kv) connected"));
kvRedis.on("error", (err) => console.error("[read-state] Redis (kv) error:", err));

// KV cache (port 6382) — read-state caches: `rs:latest:ch:*`, `rs:latest:dm:*`,
// `rs:cs:<user>:<channel>`, `rs:ds:<user>:<conv>`, `rs:mc:<user>:<channel>`.
// Cuts Cassandra reads for unread/state lookups.
export const kvCacheRedis = new Redis(env.KV_CACHE_REDIS_URL);

kvCacheRedis.on("connect", () => console.log("[read-state] Redis (kv-cache) connected"));
kvCacheRedis.on("error", (err) => console.error("[read-state] Redis (kv-cache) error:", err));
