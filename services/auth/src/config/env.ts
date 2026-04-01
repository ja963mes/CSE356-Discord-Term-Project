import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Workspace scripts run with `cwd` set to the package directory, so we
// explicitly load the repo-root `.env`.
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const envSchema = z.object({
  PORT: z.string().default("3001"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  SESSION_SECRET: z.string().min(16),
  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  // OAuth - Google
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_CALLBACK_URL: z.string().default("http://localhost:3001/auth/google/callback"),

  // OAuth - GitHub
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  GITHUB_CALLBACK_URL: z.string().default("http://localhost:3001/auth/github/callback"),

  // OIDC - Course provider (CSE 356)
  OIDC_ISSUER_URL: z.string().default("https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth"),
  OIDC_CLIENT_ID: z.string().default("web-service"),
  OIDC_CLIENT_SECRET: z.string().default("web-service-secret"),
  OIDC_CALLBACK_URL: z.string().default("http://localhost:3001/auth/oidc/callback"),
});

export const env = envSchema.parse(process.env);