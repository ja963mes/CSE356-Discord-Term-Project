import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Repo root — __dirname is the src/ dir, so 3 levels up.
const repoRoot = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });
if (process.env.ENV_FILE) {
  // Resolve relative paths from repo root — npm workspaces set cwd to the
  // package dir before running scripts, so a bare filename like
  // ".env.staging-infra-local" would otherwise resolve to services/search/.
  const envFilePath = path.isAbsolute(process.env.ENV_FILE)
    ? process.env.ENV_FILE
    : path.join(repoRoot, process.env.ENV_FILE);
  dotenv.config({ path: envFilePath, override: true });
}

const envSchema = z.object({
  SEARCH_PORT: z.string().default("3004"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  /** Meta pubsub (subscribes to community:events) — port 6381 instance. */
  META_REDIS_URL: z.string(),
  /** KV redis (sessions) — port 6380 instance. */
  KV_REDIS_URL: z.string(),
  /** KV cache redis (comm:e:dir) — port 6382 instance. */
  KV_CACHE_REDIS_URL: z.string(),
  /** Base URL for backend nginx (used for search fallback scans). Example: http://10.0.2.247 */
  BACKEND_API_URL: z.string().url().default("http://10.0.2.247"),
  /** Pino: trace | debug | info | warn | error | fatal */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
  ELASTICSEARCH_URL: z.string().default("http://localhost:9200"),
  ES_INDEX_NAME: z.string().default("messages"),
  /** Elasticsearch index for public community directory search (`/directory/communities`). */
  ES_COMMUNITIES_INDEX_NAME: z.string().default("communities_directory"),
});

export const env = envSchema.parse(process.env);
