import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../env";
import * as schema from "./pgSchema";

const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

export const pg = drizzle(pool, { schema });
