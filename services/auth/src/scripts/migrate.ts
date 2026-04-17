import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/** Directory containing `drizzle.config.ts` (`services/auth`), regardless of ts-node `__dirname`. */
function findAuthServiceRoot(): string {
  const markers = ["drizzle.config.ts", "drizzle.config.js"];
  const walkUp = (start: string): string | undefined => {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      if (markers.some((m) => fs.existsSync(path.join(dir, m)))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  };

  const seeds = [
    path.resolve(__dirname),
    path.resolve(process.cwd()),
    path.join(process.cwd(), "services", "auth"),
  ];

  for (const seed of seeds) {
    const found = walkUp(seed);
    if (found) return found;
  }

  throw new Error(
    "Could not find services/auth (no drizzle.config.ts). Run: npm run db:migrate from the repo root, or cd services/auth first.",
  );
}

const authRoot = findAuthServiceRoot();
// Match `drizzle.config.ts`: repo-root `.env` is two levels above `services/auth`.
const envPath = path.resolve(authRoot, "../../.env");
dotenv.config({ path: envPath });

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
