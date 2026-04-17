import path from "path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Same repo-root `.env` as `drizzle.config.ts` (that file lives in `services/auth/`).
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const migrateUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!migrateUrl) {
  console.error("Set DATABASE_URL or DATABASE_URL_DIRECT for migrations.");
  process.exit(1);
}

const migrationsFolder = path.resolve(__dirname, "../../drizzle");

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: migrateUrl });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    console.log("Migrations finished successfully.");
  } catch (err) {
    console.error("Migration failed:");
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
