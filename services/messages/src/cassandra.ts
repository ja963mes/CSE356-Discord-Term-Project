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

/** Temp client without keyspace — used to create keyspace + table. */
const bootstrapClient = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

export const cassandra = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  keyspace: env.MESSAGES_CASSANDRA_KEYSPACE,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

function buildKeyspaceCql(): string {
  const ks = env.MESSAGES_CASSANDRA_KEYSPACE;
  const rf = env.CASSANDRA_REPLICATION_FACTOR;
  if (env.CASSANDRA_TOPOLOGY === "network") {
    const dc = env.CASSANDRA_LOCAL_DATACENTER.replace(/'/g, "''");
    return `CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = {'class': 'NetworkTopologyStrategy', '${dc}': ${rf}} AND durable_writes = true`;
  }
  return `CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': ${rf}} AND durable_writes = true`;
}

function buildTableCql(): string {
  const ks = env.MESSAGES_CASSANDRA_KEYSPACE;
  return `
CREATE TABLE IF NOT EXISTS ${ks}.messages_by_channel (
  channel_id uuid,
  created_at timeuuid,
  message_id uuid,
  community_id uuid,
  author_id uuid,
  author_username text,
  content text,
  is_deleted boolean,
  edited_at timestamp,
  attachment_keys list<text>,
  PRIMARY KEY ((channel_id), created_at, message_id)
) WITH CLUSTERING ORDER BY (created_at DESC, message_id ASC);
`.trim();
}

/** ALTER TABLE statements to add new columns to existing tables — all idempotent (IF NOT EXISTS not supported for ALTER, so we swallow errors). */
async function migrateTableCql(client: { execute: (cql: string) => Promise<unknown> }): Promise<void> {
  const ks = env.MESSAGES_CASSANDRA_KEYSPACE;
  const alters = [
    `ALTER TABLE ${ks}.messages_by_channel ADD is_deleted boolean`,
    `ALTER TABLE ${ks}.messages_by_channel ADD edited_at timestamp`,
    `ALTER TABLE ${ks}.messages_by_channel ADD attachment_keys list<text>`,
  ];
  for (const cql of alters) {
    try {
      await client.execute(cql);
    } catch {
      // Column already exists — safe to ignore
    }
  }
}

export async function initializeCassandra(): Promise<void> {
  await bootstrapClient.connect();
  await bootstrapClient.execute(buildKeyspaceCql());
  await bootstrapClient.execute(buildTableCql());
  await migrateTableCql(bootstrapClient);
  await bootstrapClient.shutdown();
  await cassandra.connect();
}

export function parseBeforeCursor(raw: string): types.TimeUuid | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    return types.TimeUuid.fromString(s);
  } catch {
    try {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return null;
      return types.TimeUuid.fromDate(d);
    } catch {
      return null;
    }
  }
}
