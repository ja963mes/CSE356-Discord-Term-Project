import { Client, auth, types } from "cassandra-driver";
import { env } from "./env";

const credentials =
  env.CASSANDRA_USERNAME && env.CASSANDRA_PASSWORD
    ? new auth.PlainTextAuthProvider(env.CASSANDRA_USERNAME, env.CASSANDRA_PASSWORD)
    : undefined;

const contactPoints = env.CASSANDRA_CONTACT_POINTS.split(",")
  .map((cp) => cp.trim())
  .filter(Boolean);

function consistencyFromName(
  name: "one" | "localOne" | "quorum" | "localQuorum" | "all"
): number {
  const m: Record<string, number> = {
    one: types.consistencies.one,
    localOne: types.consistencies.localOne,
    quorum: types.consistencies.quorum,
    localQuorum: types.consistencies.localQuorum,
    all: types.consistencies.all,
  };
  return m[name] ?? types.consistencies.localOne;
}

export const readConsistency = consistencyFromName(env.CASSANDRA_READ_CONSISTENCY);
export const writeConsistency = consistencyFromName(env.CASSANDRA_WRITE_CONSISTENCY);

const bootstrapClient = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

export const cassandra = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  keyspace: env.READ_STATE_CASSANDRA_KEYSPACE,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

export const messagesCassandra = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  keyspace: env.MESSAGES_CASSANDRA_KEYSPACE,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

export const dmsCassandra = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  keyspace: env.DMS_CASSANDRA_KEYSPACE,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

function buildKeyspaceCql(): string {
  const ks = env.READ_STATE_CASSANDRA_KEYSPACE;
  const rf = env.CASSANDRA_REPLICATION_FACTOR;
  if (env.CASSANDRA_TOPOLOGY === "network") {
    const dc = env.CASSANDRA_LOCAL_DATACENTER.replace(/'/g, "''");
    return `CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = {'class': 'NetworkTopologyStrategy', '${dc}': ${rf}} AND durable_writes = true`;
  }
  return `CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': ${rf}} AND durable_writes = true`;
}

function buildTableCql(): string[] {
  const ks = env.READ_STATE_CASSANDRA_KEYSPACE;
  return [
    `
CREATE TABLE IF NOT EXISTS ${ks}.channel_state_by_user (
  user_id uuid,
  channel_id uuid,
  last_read_message_id uuid,
  last_read_timeuuid timeuuid,
  updated_at timestamp,
  PRIMARY KEY ((user_id), channel_id)
)`.trim(),
    `
CREATE TABLE IF NOT EXISTS ${ks}.channel_mentions_by_user (
  user_id uuid,
  channel_id uuid,
  mention_count counter,
  PRIMARY KEY ((user_id), channel_id)
)`.trim(),
    `
CREATE TABLE IF NOT EXISTS ${ks}.dm_state_by_user (
  user_id uuid,
  conversation_id uuid,
  last_read_message_id uuid,
  last_read_timeuuid timeuuid,
  updated_at timestamp,
  PRIMARY KEY ((user_id), conversation_id)
)`.trim(),
  ];
}

export async function initializeCassandra(): Promise<void> {
  await bootstrapClient.connect();
  await bootstrapClient.execute(buildKeyspaceCql());
  for (const cql of buildTableCql()) {
    await bootstrapClient.execute(cql);
  }
  await bootstrapClient.shutdown();
  await Promise.all([cassandra.connect(), messagesCassandra.connect(), dmsCassandra.connect()]);
}
