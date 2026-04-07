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
  REDIS_URL: z.string(),
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
  /** MinIO / S3-compatible object storage */
  MINIO_ENDPOINT: z.string().default("http://localhost:9000"),
  MINIO_ACCESS_KEY: z.string().default("minioadmin"),
  MINIO_SECRET_KEY: z.string().default("minioadmin"),
  MINIO_BUCKET: z.string().default("discord-attachments"),
  /** Base URL for serving attachments. Override with nginx proxy URL in production. */
  ATTACHMENT_BASE_URL: z.string().default("http://localhost:9000/discord-attachments"),
});

export const env = envSchema.parse(process.env);
