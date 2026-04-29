import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Workspace scripts run with `cwd` set to the package directory, so we
// explicitly load the repo-root `.env`.
// Repo root — __dirname is services/auth/src/config, so 4 levels up.
const repoRoot = path.resolve(__dirname, "../../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });
// Optional override for staging/local switching: ENV_FILE=/path/to/.env.staging
if (process.env.ENV_FILE) {
  // Resolve relative paths from repo root — npm workspaces set cwd to the
  // package dir before running scripts, so a bare filename like
  // ".env.staging-infra-local" would otherwise resolve to services/auth/.
  const envFilePath = path.isAbsolute(process.env.ENV_FILE)
    ? process.env.ENV_FILE
    : path.join(repoRoot, process.env.ENV_FILE);
  dotenv.config({ path: envFilePath, override: true });
}

const envSchema = z.object({
  PORT: z.string().default("3001"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  /** KV redis (sessions, oauth_state, oauth_temp) — port 6380 instance. */
  KV_REDIS_URL: z.string(),
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

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
});

export const env = envSchema.parse(process.env);