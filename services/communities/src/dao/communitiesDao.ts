import { eq, count } from "drizzle-orm";
import { db } from "../db";
import { communities, communityMembers, channels, channelMembers } from "../db/schema";
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

export async function countByCreator(userId: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(communities)
    .where(eq(communities.created_by, userId));
  return Number(row?.c ?? 0);
}

export async function createWithOwnerAndGeneralChannel(
  userId: string,
  name: string,
): Promise<{ id: string; name: string; created_at: Date }> {
  return db.transaction(async (tx) => {
    const [c] = await tx.insert(communities).values({ name, created_by: userId }).returning();
    await tx.insert(communityMembers).values({
      community_id: c.id,
      user_id: userId,
      role: "owner",
    });
    const [general] = await tx
      .insert(channels)
      .values({
        community_id: c.id,
        name: "general",
        type: "text",
        position: 0,
        is_private: false,
      })
      .returning({ id: channels.id });
    await tx.insert(channelMembers).values({ channel_id: general.id, user_id: userId });
    return {
      id: c.id,
      name: c.name,
      created_at: c.created_at instanceof Date ? c.created_at : new Date(String(c.created_at)),
    };
  });
}
