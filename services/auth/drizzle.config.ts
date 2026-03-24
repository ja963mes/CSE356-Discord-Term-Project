import type { Config } from "drizzle-kit";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from the .env file
// not sure if u guys had the same issue, but without this, my env vars weren't being loaded
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
} satisfies Config;