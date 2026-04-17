import { eq } from "drizzle-orm";
import { db } from "../db";
import { communities, communityMembers } from "../db/schema";
import { UserCommunityRow } from "./types";

export async function listForUser(userId: string): Promise<UserCommunityRow[]> {
  return db
    .select({
      id: communities.id,
      name: communities.name,
      created_at: communities.created_at,
      role: communityMembers.role,
    })
    .from(communities)
    .innerJoin(communityMembers, eq(communities.id, communityMembers.community_id))
    .where(eq(communityMembers.user_id, userId));
}

export async function existsById(communityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.id, communityId))
    .limit(1);
  return Boolean(row);
}
