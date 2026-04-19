import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

export const env = {
  PORT: process.env.REALTIME_PORT ?? "3005",
  REDIS_URL: process.env.REDIS_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  LOG_PRETTY: process.env.LOG_PRETTY === "true",
  CASSANDRA_CONTACT_POINTS: process.env.CASSANDRA_CONTACT_POINTS ?? "127.0.0.1",
  CASSANDRA_PORT: parseInt(process.env.CASSANDRA_PORT ?? "9042", 10),
  CASSANDRA_LOCAL_DATACENTER: process.env.CASSANDRA_LOCAL_DATACENTER ?? "datacenter1",
  CASSANDRA_KEYSPACE: process.env.CASSANDRA_KEYSPACE ?? "dms",
  ATTACHMENT_BASE_URL: process.env.ATTACHMENT_BASE_URL ?? "",
};
