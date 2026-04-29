import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Repo root — __dirname is the src/ dir, so 3 levels up.
const repoRoot = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  // Resolve relative paths from repo root — npm workspaces set cwd to the
  // package dir before running scripts, so a bare filename like
  // ".env.staging-infra-local" would otherwise resolve to services/communities/.
  const envFilePath = path.isAbsolute(process.env.ENV_FILE)
    ? process.env.ENV_FILE
    : path.join(repoRoot, process.env.ENV_FILE);
  dotenv.config({ path: envFilePath, override: true });
}

const envSchema = z.object({
  COMMUNITIES_PORT: z.string().default("3002"),
  DATABASE_URL: z.string().url(),
  /** Base URL for search-service (Elasticsearch-backed directory). */
  SEARCH_SERVICE_URL: z.string().url().default("http://127.0.0.1:3004"),
  REDIS_URL: z.string(),
  /** Meta pubsub (community:events publishes) — port 6381 instance. */
  META_REDIS_URL: z.string(),
  /** KV redis (sessions) — port 6380 instance. */
  KV_REDIS_URL: z.string(),
  /** KV cache redis (comm:e:*, comm:c:*) — port 6382 instance. */
  KV_CACHE_REDIS_URL: z.string(),
  /** Pino log level: trace | debug | info | warn | error | fatal */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  /** Pretty-print logs for easier tail/journalctl reading. */
  LOG_PRETTY: z.coerce.boolean().default(true),
});

export const env = envSchema.parse(process.env);
