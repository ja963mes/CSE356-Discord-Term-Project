import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "./env";
import * as schema from "./db/schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_DIRECT || env.DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
