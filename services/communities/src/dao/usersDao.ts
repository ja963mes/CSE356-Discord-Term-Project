import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";

export async function getUsernameAndProfileById(userId: string): Promise<{
  username: string;
  profile: unknown;
} | null> {
  const [row] = await db
    .select({ username: users.username, profile: users.profile })
    .from(users)
    .where(eq(users.internal_id, userId))
    .limit(1);
  return row ?? null;
}
