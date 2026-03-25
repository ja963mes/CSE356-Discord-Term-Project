import type { Config } from "drizzle-kit";
import dotenv from "dotenv";
import path from "path";

// `drizzle-kit` runs with cwd `services/auth`; load repo-root `.env` like `src/config/env.ts`.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;