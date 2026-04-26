import Redis from "ioredis";
import { env } from "./env";

// Pubsub instance (port 6379) — subscribes to `channel:events`, `dm:events`.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[search] Redis (pubsub) connected"));
redis.on("error", (err) => console.error("[search] Redis (pubsub) error:", err));

// Meta pubsub (port 6381) — subscribes to `community:events`.
export const metaRedis = new Redis(env.META_REDIS_URL);
metaRedis.on("connect", () => console.log("[search] Redis (meta) connected"));
metaRedis.on("error", (err) => console.error("[search] Redis (meta) error:", err));

// KV instance (port 6380) — sessions (`session:*`) only.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => console.log("[search] Redis (kv) connected"));
kvRedis.on("error", (err) => console.error("[search] Redis (kv) error:", err));

// KV cache (port 6382) — `comm:e:dir` epoch INCR (community directory cache).
export const kvCacheRedis = new Redis(env.KV_CACHE_REDIS_URL);
kvCacheRedis.on("connect", () => console.log("[search] Redis (kv-cache) connected"));
kvCacheRedis.on("error", (err) => console.error("[search] Redis (kv-cache) error:", err));
