import { Client, auth, types } from "cassandra-driver";
import { env } from "./env";
import { logger } from "./logger";

const credentials =
  env.CASSANDRA_USERNAME && env.CASSANDRA_PASSWORD
    ? new auth.PlainTextAuthProvider(env.CASSANDRA_USERNAME, env.CASSANDRA_PASSWORD)
    : undefined;

const contactPoints = env.CASSANDRA_CONTACT_POINTS.split(",")
  .map((cp) => cp.trim())
  .filter(Boolean);

function consistencyFromName(name: "one" | "localOne" | "quorum" | "localQuorum" | "all"): number {
  const m: Record<string, number> = {
    one: types.consistencies.one,
    localOne: types.consistencies.localOne,
    quorum: types.consistencies.quorum,
    localQuorum: types.consistencies.localQuorum,
    all: types.consistencies.all,
  };
  return m[name] ?? types.consistencies.localQuorum;
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
  keyspace: env.CASSANDRA_KEYSPACE,
  protocolOptions: { port: env.CASSANDRA_PORT },
  authProvider: credentials,
});

function buildKeyspaceCql(): string {
  const ks = env.CASSANDRA_KEYSPACE;
  const rf = env.CASSANDRA_REPLICATION_FACTOR;
  if (env.CASSANDRA_TOPOLOGY === "network") {
    const dc = env.CASSANDRA_LOCAL_DATACENTER.replace(/'/g, "''");
    return `CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = {'class': 'NetworkTopologyStrategy', '${dc}': ${rf}} AND durable_writes = true`;
  }
  return `CREATE KEYSPACE IF NOT EXISTS ${ks} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': ${rf}} AND durable_writes = true`;
}

function buildTableCql(): string {
  const ks = env.CASSANDRA_KEYSPACE;
  return `
CREATE TABLE IF NOT EXISTS ${ks}.messages_by_conversation (
  conversation_id uuid,
  created_at timeuuid,
  message_id uuid,
  author_id uuid,
  content text,
  attachments text,
  attachment_keys list<text>,
  updated_at timestamp,
  is_deleted boolean,
  PRIMARY KEY ((conversation_id), created_at, message_id)
) WITH CLUSTERING ORDER BY (created_at DESC, message_id ASC);
`.trim();
}

async function runAlters(): Promise<void> {
  const ks = env.CASSANDRA_KEYSPACE;
  const alters = [
    `ALTER TABLE ${ks}.messages_by_conversation ADD is_deleted boolean`,
    `ALTER TABLE ${ks}.messages_by_conversation ADD attachment_keys list<text>`,
    `ALTER TABLE ${ks}.messages_by_conversation ADD updated_at timestamp`,
  ];
  for (const cql of alters) {
    try {
      await cassandra.execute(cql);
    } catch {
      // column already present
    }
  }
}

export async function initializeCassandra(): Promise<void> {
  await bootstrapClient.connect();
  await bootstrapClient.execute(buildKeyspaceCql());
  await bootstrapClient.execute(buildTableCql());
  await bootstrapClient.shutdown();
  await cassandra.connect();
  await runAlters();
  logger.info(
    {
      keyspace: env.CASSANDRA_KEYSPACE,
      read: env.CASSANDRA_READ_CONSISTENCY,
      write: env.CASSANDRA_WRITE_CONSISTENCY,
    },
    "cassandra ready"
  );
}
