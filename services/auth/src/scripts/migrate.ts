import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadDotenvFromRepoRoot } from "./drizzlePaths";

const { authRoot, envPath } = loadDotenvFromRepoRoot();

const migrateUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!migrateUrl) {
  console.error("Set DATABASE_URL or DATABASE_URL_DIRECT for migrations.");
  if (!fs.existsSync(envPath)) {
    console.error(`No .env at ${envPath} (repo root). Copy .env.example there.`);
  } else {
    console.error(
      `.env exists at ${envPath} but DATABASE_URL and DATABASE_URL_DIRECT are unset or empty.`,
    );
  }
  process.exit(1);
}

const migrationsFolder = path.join(authRoot, "drizzle");

function hintIfAlreadyExists(err: unknown): void {
  const e = err as { cause?: { code?: string; message?: string } };
  const code = e?.cause?.code;
  const msg = String(e?.cause?.message ?? err);
  if (code === "42P07" || /already exists/i.test(msg)) {
    console.error(
      "\nThis usually means the database schema was created without Drizzle's journal table " +
        "(`drizzle.__drizzle_migrations`), so migrate tries to replay old SQL.\n" +
        "If your tables already match migrations 0..9, baseline the journal, then migrate again:\n" +
        "  npm run db:migrate:stamp --workspace auth-service -- --through 9\n" +
        "  npm run db:migrate --workspace auth-service\n",
    );
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: migrateUrl });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    console.log("Migrations finished successfully.");
  } catch (err) {
    console.error("Migration failed:");
    console.error(err);
    hintIfAlreadyExists(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
