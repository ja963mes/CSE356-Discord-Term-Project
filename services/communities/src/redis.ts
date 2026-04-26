import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

// Pubsub instance (port 6379) — kept exported for symmetry; communities does
// not currently publish on this channel set. Meta pubsub holds community:events.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) error"));

// Meta pubsub (port 6381) — community:events publishes go here.
export const metaRedis = new Redis(env.META_REDIS_URL);
metaRedis.on("connect", () => logger.info("redis (meta) connected"));
metaRedis.on("error", (err) => logger.error({ err }, "redis (meta) error"));

// KV instance (port 6380) — sessions (`session:*`) only.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) error"));

// KV cache (port 6382) — community read-cache (`comm:e:*`, `comm:c:*`).
// Separate from sessions so cache traffic can't stall session GETs on the
// single-threaded redis event loop.
export const kvCacheRedis = new Redis(env.KV_CACHE_REDIS_URL);
kvCacheRedis.on("connect", () => logger.info("redis (kv-cache) connected"));
kvCacheRedis.on("error", (err) => logger.error({ err }, "redis (kv-cache) error"));
