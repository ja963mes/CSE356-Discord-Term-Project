import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const envSchema = z.object({
  SEARCH_COMMUNITIES_PORT: z.string().default("3007"),
  DATABASE_URL: z.string().url(),
});

export const env = envSchema.parse(process.env);

