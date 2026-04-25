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

// Pubsub instance — `channel:events` publishes go here.
export const redis = new Redis(env.REDIS_URL, redisClientOptions);

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) client error"));

// KV instance — sessions (`session:*`). Lives on a separate redis-server
// (port 6380) so session GETs aren't queued behind pubsub fanout on the
// single-threaded event loop.
export const kvRedis = new Redis(env.KV_REDIS_URL, redisClientOptions);

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) client error"));
