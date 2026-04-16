import Redis from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

export const redis = new Redis(env.REDIS_URL);

redis.on("connect", () => logger.info("redis connected"));
redis.on("error", (err) => logger.error({ err }, "redis client error"));
