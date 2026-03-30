import { Pool } from "pg";
import { Client as CassandraClient } from "cassandra-driver";
import { env } from "./env";

export const pg = new Pool({ connectionString: env.DATABASE_URL });

export const cassandra = new CassandraClient({
  contactPoints: env.CASSANDRA_CONTACT_POINTS.split(",").map((s) => s.trim()),
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  protocolOptions: { port: env.CASSANDRA_PORT },
});

export const initDb = async (): Promise<void> => {
  await cassandra.connect();
};
