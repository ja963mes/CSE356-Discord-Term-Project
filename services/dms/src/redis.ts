import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

// Pubsub instance — per-participant `dm:userfeed:N` publishes go here.
export const redis = new Redis(env.REDIS_URL, {
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("ready", () => logger.info("redis (pubsub) ready"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) client error"));
redis.on("end", () => logger.warn("redis (pubsub) connection ended"));
redis.on("reconnecting", (ms: number) => logger.warn({ delayMs: ms }, "redis (pubsub) reconnecting"));

// KV instance (port 6380) — sessions (`session:*`) + INSTANCE_REGISTRY hgetall.
export const kvRedis = new Redis(env.KV_REDIS_URL, {
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("ready", () => logger.info("redis (kv) ready"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) client error"));
kvRedis.on("end", () => logger.warn("redis (kv) connection ended"));
kvRedis.on("reconnecting", (ms: number) => logger.warn({ delayMs: ms }, "redis (kv) reconnecting"));

// KV cache (port 6382) — `dm:pending:*` lpush/ltrim/expire.
export const kvCacheRedis = new Redis(env.KV_CACHE_REDIS_URL, {
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

kvCacheRedis.on("connect", () => logger.info("redis (kv-cache) connected"));
kvCacheRedis.on("ready", () => logger.info("redis (kv-cache) ready"));
kvCacheRedis.on("error", (err) => logger.error({ err }, "redis (kv-cache) client error"));
kvCacheRedis.on("end", () => logger.warn("redis (kv-cache) connection ended"));
kvCacheRedis.on("reconnecting", (ms: number) => logger.warn({ delayMs: ms }, "redis (kv-cache) reconnecting"));
