import Redis from "ioredis";
import { env } from "./env";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[communities] Redis connected"));
redis.on("error", (err) => console.error("[communities] Redis error:", err));
