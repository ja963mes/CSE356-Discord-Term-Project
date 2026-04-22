import { Pool } from "pg";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const kvRedis = new Redis(process.env.KV_REDIS_URL ?? process.env.REDIS_URL!);

export type TestUser = { userId: string; username: string; sessionToken: string; cookie: string };

/** Insert a real user into Postgres and a session into Redis. Returns a cookie header string. */
export async function createTestUser(username?: string): Promise<TestUser> {
  const userId = randomUUID();
  const name = username ?? `testuser_${userId.slice(0, 8)}`;
  await pool.query(
    `INSERT INTO users (internal_id, username, email, profile) VALUES ($1, $2, $3, '{}')`,
    [userId, name, `${name}@test.com`]
  );
  const token = randomUUID();
  await kvRedis.set(`session:${token}`, userId, "EX", 3600);
  return { userId, username: name, sessionToken: token, cookie: `session_token=${token}` };
}

/** Clean up users and sessions created during a test run. */
export async function cleanupUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pool.query(
    `DELETE FROM users WHERE internal_id = ANY($1::uuid[])`,
    [userIds]
  );
}

export async function closeConnections(): Promise<void> {
  await pool.end();
  await kvRedis.quit();
}
