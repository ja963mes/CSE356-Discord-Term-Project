import Redis from "ioredis";
import { env } from "../config/env";
import { logger } from "../logger";

// Pubsub instance — kept for symmetry across services. Auth itself does not
// publish or subscribe today, but keeping this client makes the boilerplate
// uniform with every other service. ioredis lazy-connects, so the cost is
// minimal until first use.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) error"));

// KV instance — sessions (`session:*`), OAuth temp + state
// (`oauth_temp:*`, `oauth_state:*`). Lives on a separate redis-server
// instance (port 6380) on the same Redis VM so pubsub fanout cannot stall
// session GETs on the single-threaded redis event loop.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => logger.info("redis (kv) connected"));
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) error"));
