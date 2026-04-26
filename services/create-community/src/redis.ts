import Redis from "ioredis";
import { env } from "./env";

// Pubsub instance (port 6379) — kept for symmetry; create-community publishes
// on meta pubsub only.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[create-community] Redis (pubsub) connected"));
redis.on("error", (err) => console.error("[create-community] Redis (pubsub) error:", err));

// Meta pubsub (port 6381) — community:events publishes go here.
export const metaRedis = new Redis(env.META_REDIS_URL);
metaRedis.on("connect", () => console.log("[create-community] Redis (meta) connected"));
metaRedis.on("error", (err) => console.error("[create-community] Redis (meta) error:", err));

// KV instance (port 6380) — sessions only.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => console.log("[create-community] Redis (kv) connected"));
kvRedis.on("error", (err) => console.error("[create-community] Redis (kv) error:", err));

// KV cache (port 6382) — comm:e:* INCR pipeline (cache invalidation epochs).
export const kvCacheRedis = new Redis(env.KV_CACHE_REDIS_URL);
kvCacheRedis.on("connect", () => console.log("[create-community] Redis (kv-cache) connected"));
kvCacheRedis.on("error", (err) => console.error("[create-community] Redis (kv-cache) error:", err));
