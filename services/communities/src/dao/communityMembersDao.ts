import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { communityMembers, users } from "../db/schema";
import { CommunityMemberListRow } from "./types";

export async function getMembership(communityId: string, userId: string): Promise<{ role: string } | null> {
  const [row] = await db
    .select({ role: communityMembers.role })
    .from(communityMembers)
    .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
    .limit(1);
  return row ?? null;
}

export async function addMember(
  communityId: string,
  userId: string,
  role: "member" | "owner" | "admin" = "member"
): Promise<{ joined_at: Date }> {
  const [row] = await db
    .insert(communityMembers)
    .values({ community_id: communityId, user_id: userId, role })
    .returning({ joined_at: communityMembers.joined_at });
  return row;
}

export async function removeMember(communityId: string, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(communityMembers)
    .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
    .returning({ community_id: communityMembers.community_id });
  return deleted.length > 0;
}

export async function listUserIdsByCommunity(communityId: string): Promise<string[]> {
  const rows = await db
    .select({ user_id: communityMembers.user_id })
    .from(communityMembers)
    .where(eq(communityMembers.community_id, communityId));
  return rows.map((r) => r.user_id);
}

export async function listMembersWithProfiles(communityId: string): Promise<CommunityMemberListRow[]> {
  const rows = await db
    .select({
      user_id: communityMembers.user_id,
      username: users.username,
      profile: users.profile,
      role: communityMembers.role,
      joined_at: communityMembers.joined_at,
    })
    .from(communityMembers)
    .innerJoin(users, eq(users.internal_id, communityMembers.user_id))
    .where(eq(communityMembers.community_id, communityId));

  return rows.map((row) => {
    const profile = (row.profile as { displayName?: string } | null) ?? {};
    return {
      user_id: row.user_id,
      username: row.username,
      display_name: profile.displayName ?? row.username,
      role: row.role,
      joined_at: row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
    };
  });
}
