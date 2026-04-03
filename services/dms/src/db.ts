import { Client, auth } from "cassandra-driver";
import { env } from "./env";
import { buildSchemaStatements } from "./db/schema";
import { buildSchemaStatementsTemp } from "./db/schema";


const credentials =
  env.CASSANDRA_USERNAME && env.CASSANDRA_PASSWORD
    ? new auth.PlainTextAuthProvider(env.CASSANDRA_USERNAME, env.CASSANDRA_PASSWORD)
    : undefined;

const contactPoints = env.CASSANDRA_CONTACT_POINTS.split(",")
  .map((cp) => cp.trim())
  .filter(Boolean);

export const cassandra = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  keyspace: env.CASSANDRA_KEYSPACE,
  protocolOptions: {
    port: env.CASSANDRA_PORT,
  },
  authProvider: credentials,
});

export const cassandraTemp = new Client({
  contactPoints,
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  protocolOptions: {
  port: env.CASSANDRA_PORT,
  },
  authProvider: credentials,

});


export const initializeCassandra = async (): Promise<void> => {
  await cassandraTemp.connect();
  const schemaStatementsTemp = buildSchemaStatementsTemp(env.CASSANDRA_KEYSPACE);
  for (const cql of schemaStatementsTemp) {
    await cassandraTemp.execute(cql);
  }
  await cassandraTemp.shutdown();
  await cassandra.connect();
  const schemaStatements = buildSchemaStatements(env.CASSANDRA_KEYSPACE);
  for (const cql of schemaStatements) {
    await cassandra.execute(cql);
  }
  const migrations = [
    `ALTER TABLE ${env.CASSANDRA_KEYSPACE}.messages_by_conversation ADD is_deleted boolean`,
    `ALTER TABLE ${env.CASSANDRA_KEYSPACE}.messages_by_conversation ADD attachment_keys list<text>`,
    `ALTER TABLE ${env.CASSANDRA_KEYSPACE}.messages_by_conversation ADD updated_at timestamp`,
  ];
  for (const cql of migrations) {
    try {
      await cassandra.execute(cql);
    } catch {
      // Column already present — safe to ignore
    }
  }
};