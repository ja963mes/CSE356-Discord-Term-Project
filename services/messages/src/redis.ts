import Redis, { type RedisOptions } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

/** Shared client tuning: bounded connect time, reconnection backoff, extra command retries
 * for short Redis/event-loop stalls. Does not fix an overloaded or down Redis; pair with
 * enough capacity on the Redis host and Nginx. */
const redisClientOptions: RedisOptions = {
  connectTimeout: 10_000,
  maxRetriesPerRequest: 30,
  keepAlive: 30_000,
  enableReadyCheck: true,
  retryStrategy(attempt) {
    if (attempt > 10) {
      return null;
    }
    return Math.min(200 * 2 ** (attempt - 1), 4_000);
  },
  reconnectOnError(err) {
    const msg = (err as Error).message;
    if (msg.includes("READONLY")) return 1;
    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("ECONNREFUSED")) {
      return 1;
    }
    return false;
  },
};

// Pubsub shard 0 — even-hashed channel:events go here.
export const redis = new Redis(env.REDIS_URL, redisClientOptions);

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) client error"));

// Pubsub shard 1 (port 6381) — odd-hashed channel:events go here.
export const pubsub2Redis = new Redis(env.PUBSUB2_REDIS_URL, redisClientOptions);

pubsub2Redis.on("connect", () => logger.info("redis (pubsub2) connected"));
pubsub2Redis.on("error", (err) => logger.error({ err }, "redis (pubsub2) client error"));

// KV instance (port 6380) — sessions (`session:*`).
export const kvRedis = new Redis(env.KV_REDIS_URL, redisClientOptions);

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) client error"));

// KV cache (port 6382) — `rs:latest:ch:*` writes after every channel insert
// so read-state can skip a `messages_by_channel LIMIT 1` Cassandra read.
export const kvCacheRedis = new Redis(env.KV_CACHE_REDIS_URL, redisClientOptions);

kvCacheRedis.on("connect", () => logger.info("redis (kv-cache) connected"));
kvCacheRedis.on("error", (err) => logger.error({ err }, "redis (kv-cache) client error"));
