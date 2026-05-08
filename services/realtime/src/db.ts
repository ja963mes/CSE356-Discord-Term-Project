import { Pool } from "pg";
import { env } from "./env";

// Use PgBouncer (DATABASE_URL) — realtime only runs occasional catch-up queries
// on reconnect, so a small pool is sufficient. Never use DATABASE_URL_DIRECT
// here; 4 instances × uncapped pool exhausts Postgres's connection limit.
export const pg = new Pool({
  connectionString: env.DATABASE_URL,
  max: 2,
});

export const initDb = async (): Promise<void> => {
  await pg.query("SELECT 1");
};
