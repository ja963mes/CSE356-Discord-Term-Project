import Redis from "ioredis";
import { env } from "./env";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("[create-community] Redis connected"));
redis.on("error", (err) => console.error("[create-community] Redis error:", err));
