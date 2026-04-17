import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "./env";
import * as schema from "./db/schema";

// PgBouncer transaction pooling breaks server-side prepared statements (Drizzle uses them).
// Prefer direct Postgres when DATABASE_URL points at PgBouncer (see repo .env.example).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_DIRECT || env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });
