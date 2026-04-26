import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  PORT: z.string().default("3008"),
  READ_STATE_PORT: z.string().optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
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
