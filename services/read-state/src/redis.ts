import Redis from "ioredis";
import { env } from "./env";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[read-state] Redis connected"));
redis.on("error", (err) => console.error("[read-state] Redis error:", err));
