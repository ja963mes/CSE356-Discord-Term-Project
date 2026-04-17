/**
 * Baseline `drizzle.__drizzle_migrations` when the DB schema already matches applied
 * SQL migrations but the journal table is empty (e.g. schema created before Drizzle
 * migrate, or `public` vs `drizzle` schema mismatch). After stamping through N,
 * `npm run db:migrate` only runs migrations with idx > N.
 *
 * Usage: npm run db:migrate:stamp --workspace auth-service -- --through 9
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Pool } from "pg";
import { loadDotenvFromRepoRoot } from "./drizzlePaths";

function parseThrough(): number {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--through");
  if (i >= 0 && argv[i + 1] !== undefined) {
    const n = parseInt(argv[i + 1], 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid --through value: ${argv[i + 1]}`);
    }
    return n;
  }
  return 9;
}

async function main(): Promise<void> {
  const through = parseThrough();
  const { authRoot } = loadDotenvFromRepoRoot();
  const migrateUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!migrateUrl) {
    console.error("Set DATABASE_URL or DATABASE_URL_DIRECT.");
    process.exit(1);
  }

  const migrationsFolder = path.join(authRoot, "drizzle");
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };

  if (through >= journal.entries.length) {
    console.error(
      `--through ${through} is out of range; journal has entries 0..${journal.entries.length - 1}.`,
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: migrateUrl });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await pool.query(`
			CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)
		`);

    const maxRow = await pool.query<{ m: string | null }>(
      `SELECT max("created_at")::text AS m FROM "drizzle"."__drizzle_migrations"`,
    );
    const maxAt = maxRow.rows[0]?.m != null ? BigInt(maxRow.rows[0].m) : null;
    const targetWhen = BigInt(journal.entries[through].when);
    if (maxAt !== null && maxAt >= targetWhen) {
      console.log(
        `drizzle.__drizzle_migrations already has created_at >= migration ${through} (${journal.entries[through].tag}). Nothing to stamp.`,
      );
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let added = 0;
      for (let i = 0; i <= through; i++) {
        const entry = journal.entries[i];
        const dup = await client.query(
          `SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = $1 LIMIT 1`,
          [entry.when],
        );
        if ((dup.rowCount ?? 0) > 0) continue;

        const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
        const body = fs.readFileSync(sqlPath, "utf8");
        const hash = crypto.createHash("sha256").update(body).digest("hex");
        await client.query(
          `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
          [hash, entry.when],
        );
        added += 1;
      }
      await client.query("COMMIT");
      console.log(
        added > 0
          ? `Stamped ${added} migration row(s) up to ${through} (${journal.entries[through].tag}). Run: npm run db:migrate`
          : `Journal already contained rows for 0..${through}. Run: npm run db:migrate`,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
