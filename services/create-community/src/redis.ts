import Redis from "ioredis";
import { env } from "./env";

// Pubsub instance — community:events publishes go here.
export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[create-community] Redis (pubsub) connected"));
redis.on("error", (err) => console.error("[create-community] Redis (pubsub) error:", err));

// KV instance — sessions + cache invalidation epoch INCRs (comm:e:*).
export const kvRedis = new Redis(env.KV_REDIS_URL);

kvRedis.on("connect", () => console.log("[create-community] Redis (kv) connected"));
kvRedis.on("error", (err) => console.error("[create-community] Redis (kv) error:", err));
