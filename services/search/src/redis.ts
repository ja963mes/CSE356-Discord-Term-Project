import Redis from "ioredis";
import { env } from "./env";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[search] Redis connected"));
redis.on("error", (err) => console.error("[search] Redis error:", err));
