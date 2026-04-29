import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Repo root — __dirname is the src/ dir, so 3 levels up.
const repoRoot = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });
if (process.env.ENV_FILE) {
  // Resolve relative paths from repo root — npm workspaces set cwd to the
  // package dir before running scripts, so a bare filename like
  // ".env.staging-infra-local" would otherwise resolve to services/read-state/.
  const envFilePath = path.isAbsolute(process.env.ENV_FILE)
    ? process.env.ENV_FILE
    : path.join(repoRoot, process.env.ENV_FILE);
  dotenv.config({ path: envFilePath, override: true });
}

const envSchema = z.object({
  PORT: z.string().default("3008"),
  READ_STATE_PORT: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.string().optional().transform((v) => v === "true"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  /** Pubsub shard 1 (port 6381) — odd-hashed channel:events. Subscribe alongside REDIS_URL. */
  META_REDIS_URL: z.string(),
  /** KV redis (sessions) — port 6380 instance. */
  KV_REDIS_URL: z.string(),
  /** KV cache (rs:latest:*, rs:cs:*, rs:ds:*, rs:mc:*) — port 6382 instance. */
  KV_CACHE_REDIS_URL: z.string(),
  CASSANDRA_CONTACT_POINTS: z.string().default("127.0.0.1"),
  CASSANDRA_PORT: z.coerce.number().int().positive().default(9042),
  CASSANDRA_LOCAL_DATACENTER: z.string().default("datacenter1"),
  READ_STATE_CASSANDRA_KEYSPACE: z.string().default("read_state"),
  MESSAGES_CASSANDRA_KEYSPACE: z.string().default("messaging"),
  DMS_CASSANDRA_KEYSPACE: z.string().default("dms"),
  CASSANDRA_USERNAME: z.string().optional(),
  CASSANDRA_PASSWORD: z.string().optional(),
  CASSANDRA_TOPOLOGY: z.enum(["simple", "network"]).default("simple"),
  CASSANDRA_REPLICATION_FACTOR: z.coerce.number().int().min(1).max(5).default(1),
  CASSANDRA_READ_CONSISTENCY: z.enum(["one", "localOne", "quorum", "localQuorum"]).default("localOne"),
  CASSANDRA_WRITE_CONSISTENCY: z.enum(["one", "localOne", "quorum", "localQuorum", "all"]).default("localQuorum"),
});

export const env = envSchema.parse(process.env);
