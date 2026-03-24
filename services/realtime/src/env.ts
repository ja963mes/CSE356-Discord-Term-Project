import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");

export const env = {
  PORT: process.env.REALTIME_PORT ?? "3005",
  REDIS_URL: process.env.REDIS_URL,
};
