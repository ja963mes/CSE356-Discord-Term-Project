import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");
if (!process.env.META_REDIS_URL) throw new Error("META_REDIS_URL is required");
if (!process.env.KV_REDIS_URL) throw new Error("KV_REDIS_URL is required");
if (!process.env.KV_CACHE_REDIS_URL) throw new Error("KV_CACHE_REDIS_URL is required");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

export const env = {
  PORT: process.env.REALTIME_PORT ?? "3005",
  REDIS_URL: process.env.REDIS_URL,
  // Meta pubsub (community:events sub + presence:broadcast pub/sub) — port 6381.
  META_REDIS_URL: process.env.META_REDIS_URL,
  // KV redis (sessions, INSTANCE_REGISTRY) — port 6380.
  KV_REDIS_URL: process.env.KV_REDIS_URL,
  // KV cache redis (presence:*, dm:pending:* drain) — port 6382.
  KV_CACHE_REDIS_URL: process.env.KV_CACHE_REDIS_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  LOG_PRETTY: process.env.LOG_PRETTY === "true",
  CASSANDRA_CONTACT_POINTS: process.env.CASSANDRA_CONTACT_POINTS ?? "127.0.0.1",
  CASSANDRA_PORT: parseInt(process.env.CASSANDRA_PORT ?? "9042", 10),
  CASSANDRA_LOCAL_DATACENTER: process.env.CASSANDRA_LOCAL_DATACENTER ?? "datacenter1",
  CASSANDRA_KEYSPACE: process.env.CASSANDRA_KEYSPACE ?? "dms",
  // URL other services use to reach this instance for direct (non-pubsub) fanout.
  // Empty = don't register; this instance receives dm events only via redis pubsub.
  REALTIME_INTERNAL_URL: process.env.REALTIME_INTERNAL_URL ?? "",
  // Presence scope pruning: skip DMs with no activity within this window on
  // connect. `direct_conversations.updated_at` is touched on every message
  // insert in dms service, so it acts as last-activity. Dormant DMs re-enter
  // scope when a message arrives (shard handler calls subscribeDm).
  // ENABLE_DORMANT_DM_PRUNING=false disables without a redeploy.
  DORMANT_DM_WINDOW_DAYS: Number(process.env.DORMANT_DM_WINDOW_DAYS ?? "7"),
  ENABLE_DORMANT_DM_PRUNING: process.env.ENABLE_DORMANT_DM_PRUNING !== "false",
};
