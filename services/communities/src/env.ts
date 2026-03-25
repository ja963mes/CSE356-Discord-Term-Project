import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const envSchema = z.object({
  COMMUNITIES_PORT: z.string().default("3002"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
});

export const env = envSchema.parse(process.env);
