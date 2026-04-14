import { Pool } from "pg";
import { env } from "./env";

export const pg = new Pool({ connectionString: env.DATABASE_URL });

export const initDb = async (): Promise<void> => {
  // Realtime service only needs Postgres (for subscription context queries).
  // Cassandra is not used here.
  await pg.query("SELECT 1");
};
