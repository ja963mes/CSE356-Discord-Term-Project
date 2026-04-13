import Redis from "ioredis";
import { env } from "./env";
import { logError, logInfo } from "./logger";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => logInfo("redis.connected"));
redis.on("error", (err) => logError("redis.error", err));
