import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  PORT: z.string().default("3003"),
  MESSAGES_PORT: z.string().optional(),
  DATABASE_URL: z.string().url(),
  /** Per worker process. With cluster, total DB connections ≈ workers × this (watch Postgres / PgBouncer limits). */
  PG_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  REDIS_URL: z.string(),
  /** Pubsub shard 2 — port 6381. channel:events are sharded across REDIS_URL and this. */
  PUBSUB2_REDIS_URL: z.string(),
  /** KV redis (sessions) — port 6380 instance. */
  KV_REDIS_URL: z.string(),
  /** KV cache (rs:latest:ch:* writes for read-state) — port 6382 instance. */
  KV_CACHE_REDIS_URL: z.string(),
  CASSANDRA_CONTACT_POINTS: z.string().default("127.0.0.1"),
  CASSANDRA_PORT: z.coerce.number().int().positive().default(9042),
  CASSANDRA_LOCAL_DATACENTER: z.string().default("datacenter1"),
  /** Keyspace for guild channel messages (do not reuse `CASSANDRA_KEYSPACE` — the DM service uses that name for its keyspace). */
  MESSAGES_CASSANDRA_KEYSPACE: z.string().default("messaging"),
  CASSANDRA_USERNAME: z.string().optional(),
  CASSANDRA_PASSWORD: z.string().optional(),
  /** `simple` = SimpleStrategy; `network` = NetworkTopologyStrategy (multi-DC). */
  CASSANDRA_TOPOLOGY: z.enum(["simple", "network"]).default("simple"),
  CASSANDRA_REPLICATION_FACTOR: z.coerce.number().int().min(1).max(5).default(1),
  /** Read consistency: one | localOne | quorum | localQuorum */
  CASSANDRA_READ_CONSISTENCY: z.enum(["one", "localOne", "quorum", "localQuorum"]).default("localOne"),
  /** Write consistency: one | localOne | quorum | localQuorum | all */
  CASSANDRA_WRITE_CONSISTENCY: z.enum(["one", "localOne", "quorum", "localQuorum", "all"]).default("localQuorum"),
  /**
   * `pooling.coreConnectionsPerHost[local]` in cassandra-driver (v4+ uses this instead of a separate max per host in typings).
   * A 4 vCPU / 8GB messages VM can sustain more concurrent native connections to each Cassandra node per worker.
   */
  CASSANDRA_LOCAL_CORE_CONNECTIONS: z.coerce.number().int().min(1).max(32).default(2),
  /**
   * Simultaneous requests per native connection; raising can help under bursty read/write from many cluster workers.
   * Driver default is 32768 for protocol v3+.
   */
  CASSANDRA_MAX_REQUESTS_PER_CONNECTION: z.coerce.number().int().min(1).max(32768).default(2048),
  /** MinIO / S3-compatible object storage */
  MINIO_ENDPOINT: z.string().default("http://localhost:9000"),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_BUCKET: z.string().default("discord-attachments"),
  /** Base URL for serving attachments. Override with nginx proxy URL in production. */
  ATTACHMENT_BASE_URL: z.string().default("http://localhost:9000/discord-attachments"),
  /** Pino: trace | debug | info | warn | error | fatal */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
});

export const env = envSchema.parse(process.env);
