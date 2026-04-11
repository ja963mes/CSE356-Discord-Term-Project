import type { Config } from "drizzle-kit";
import dotenv from "dotenv";
import path from "path";

// `drizzle-kit` runs with cwd `services/auth`; load repo-root `.env` like `src/config/env.ts`.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const migrateUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!migrateUrl) {
  throw new Error("Set DATABASE_URL or DATABASE_URL_DIRECT for drizzle-kit");
}

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: migrateUrl,
  },
} satisfies Config;