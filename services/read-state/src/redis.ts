import Redis from "ioredis";
import { env } from "./env";

// Pubsub instance — publishes `dm:events`, subscribes to `channel:events`.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[read-state] Redis (pubsub) connected"));
redis.on("error", (err) => console.error("[read-state] Redis (pubsub) error:", err));

// KV instance — sessions (`session:*`). Separate redis-server (port 6380)
// so session GETs aren't queued behind pubsub fanout on the single-threaded
// event loop.
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => console.log("[read-state] Redis (kv) connected"));
kvRedis.on("error", (err) => console.error("[read-state] Redis (kv) error:", err));
