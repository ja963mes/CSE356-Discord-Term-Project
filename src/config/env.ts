import { z } from "zod";
import dotenv from "dotenv";
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("3001"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string(),
  SESSION_SECRET: z.string().min(16),

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