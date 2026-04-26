import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  CREATE_COMMUNITY_PORT: z.string().default("3006"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  /** Meta pubsub (community:events publishes) — port 6381 instance. */
  META_REDIS_URL: z.string(),
  /** KV redis (sessions) — port 6380 instance. */
  KV_REDIS_URL: z.string(),
  /** KV cache redis (comm:e:* INCR pipeline) — port 6382 instance. */
  KV_CACHE_REDIS_URL: z.string(),
});

export const env = envSchema.parse(process.env);
