import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  COMMUNITIES_PORT: z.string().default("3002"),
  DATABASE_URL: z.string().url(),
  /** Base URL for search-service (Elasticsearch-backed directory). */
  SEARCH_SERVICE_URL: z.string().url().default("http://127.0.0.1:3004"),
  REDIS_URL: z.string(),
  /** Pino log level: trace | debug | info | warn | error | fatal */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /** Pretty-print logs for easier tail/journalctl reading. */
  LOG_PRETTY: z.coerce.boolean().default(true),
});

export const env = envSchema.parse(process.env);
