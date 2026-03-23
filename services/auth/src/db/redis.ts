import Redis from "ioredis";
import { env } from "../config/env";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err) => console.error("Redis error:", err));