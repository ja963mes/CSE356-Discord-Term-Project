import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

export const redis = new Redis(env.REDIS_URL, {
  commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on("connect", () => logger.info("redis connected"));
redis.on("ready", () => logger.info("redis ready"));
redis.on("error", (err) => logger.error({ err }, "redis client error"));
redis.on("end", () => logger.warn("redis connection ended"));
redis.on("reconnecting", (ms: number) => logger.warn({ delayMs: ms }, "redis reconnecting"));
