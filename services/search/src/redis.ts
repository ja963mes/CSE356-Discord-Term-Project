import Redis from "ioredis";
import { env } from "./env";

// Pubsub instance — subscribes to `channel:events`, `dm:events`,
// `community:events`.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[search] Redis (pubsub) connected"));
redis.on("error", (err) => console.error("[search] Redis (pubsub) error:", err));

// KV instance — sessions (`session:*`) + `comm:e:dir` epoch INCR. Separate
// redis-server (port 6380) so KV ops aren't queued behind pubsub fanout on
// the single-threaded event loop.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => console.log("[search] Redis (kv) connected"));
kvRedis.on("error", (err) => console.error("[search] Redis (kv) error:", err));
