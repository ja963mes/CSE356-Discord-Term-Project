import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { channelMembers, communityMembers, users } from "../db/schema";
import { PrivateChannelMemberRow } from "./types";

export async function addMember(channelId: string, userId: string): Promise<void> {
  await db.insert(channelMembers).values({ channel_id: channelId, user_id: userId }).onConflictDoNothing();
}

export async function addMemberNoConflict(channelId: string, userId: string): Promise<void> {
  await db.insert(channelMembers).values({ channel_id: channelId, user_id: userId });
}

export async function addMembers(channelId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const rows = userIds.map((userId) => ({ channel_id: channelId, user_id: userId }));
  await db.insert(channelMembers).values(rows).onConflictDoNothing();
}

export async function addUserToChannels(userId: string, channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return;
  const rows = channelIds.map((channelId) => ({ channel_id: channelId, user_id: userId }));
  await db.insert(channelMembers).values(rows).onConflictDoNothing();
}

export async function removeMember(channelId: string, userId: string): Promise<boolean> {
  const removed = await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId)))
    .returning({ user_id: channelMembers.user_id });
  return removed.length > 0;
}

export async function removeUserFromChannels(userId: string, channelIds: string[]): Promise<void> {
  if (channelIds.length === 0) return;
  await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.user_id, userId), inArray(channelMembers.channel_id, channelIds)));
}

export async function hasMembership(channelId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ user_id: channelMembers.user_id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId)))
    .limit(1);
  return Boolean(row);
}

export async function listPrivateChannelMembers(
  communityId: string,
  channelId: string
): Promise<PrivateChannelMemberRow[]> {
  const rows = await db
    .select({
      user_id: users.internal_id,
      username: users.username,
      profile: users.profile,
      role: communityMembers.role,
    })
    .from(channelMembers)
    .innerJoin(users, eq(users.internal_id, channelMembers.user_id))
    .innerJoin(
      communityMembers,
      and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, channelMembers.user_id))
    )
    .where(eq(channelMembers.channel_id, channelId))
    .orderBy(asc(users.username));

  return rows.map((row) => {
    const profile = (row.profile as { displayName?: string } | null) ?? {};
    return {
      user_id: row.user_id,
      username: row.username,
      display_name: profile.displayName ?? row.username,
      role: row.role,
    };
  });
}
