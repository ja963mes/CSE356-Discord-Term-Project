import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  DMS_PORT: z.string().default("3007"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().min(1),
  /** KV redis (sessions, dm:pending:*, INSTANCE_REGISTRY) — port 6380. */
  KV_REDIS_URL: z.string().min(1),
  CASSANDRA_CONTACT_POINTS: z.string().default("127.0.0.1"),
  CASSANDRA_PORT: z.coerce.number().int().positive().default(9042),
  CASSANDRA_LOCAL_DATACENTER: z.string().default("datacenter1"),
  CASSANDRA_KEYSPACE: z.string().default("dms"),
  CASSANDRA_USERNAME: z.string().optional(),
  CASSANDRA_PASSWORD: z.string().optional(),
  CASSANDRA_TOPOLOGY: z.enum(["simple", "network"]).default("simple"),
  CASSANDRA_REPLICATION_FACTOR: z.coerce.number().int().min(1).max(5).default(1),
  /** Read consistency: one | localOne | quorum | localQuorum */
  CASSANDRA_READ_CONSISTENCY: z.enum(["one", "localOne", "quorum", "localQuorum"]).default("localQuorum"),
  /** Write consistency: one | localOne | quorum | localQuorum | all */
  CASSANDRA_WRITE_CONSISTENCY: z.enum(["one", "localOne", "quorum", "localQuorum", "all"]).default("localQuorum"),
  /** MinIO / S3-compatible object storage */
  MINIO_ENDPOINT: z.string().default("http://localhost:9000"),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_BUCKET: z.string().default("discord-attachments"),
  ATTACHMENT_BASE_URL: z.string().default("http://localhost:9000/discord-attachments"),
  /** Pino: trace | debug | info | warn | error | fatal */
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
  /** ioredis commandTimeout (ms). Caps how long an awaited redis call can block. */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export const env = envSchema.parse(process.env);
