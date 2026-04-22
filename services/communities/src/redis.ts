import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

// Pubsub instance — community:events publishes go here.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) error"));

// KV instance — sessions (`session:*`) + community read-cache
// (`comm:e:*`, `comm:c:*`). Separate redis-server (port 6380) so cache
// reads + session lookups aren't queued behind pubsub fanout.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) error"));
