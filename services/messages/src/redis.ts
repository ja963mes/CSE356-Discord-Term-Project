import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

// Pubsub instance — `channel:events` publishes go here.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) client error"));

// KV instance — sessions (`session:*`). Lives on a separate redis-server
// (port 6380) so session GETs aren't queued behind pubsub fanout on the
// single-threaded event loop.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) client error"));
