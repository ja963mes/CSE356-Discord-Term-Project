import { and, asc, eq, isNotNull, max, or, count } from "drizzle-orm";
import { db } from "../db";
import { channels, channelMembers } from "../db/schema";
import { ChannelListRow } from "./types";

export async function listPublicIdsByCommunity(communityId: string): Promise<string[]> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.community_id, communityId), eq(channels.is_private, false)));
  return rows.map((r) => r.id);
}

export async function listIdsByCommunity(communityId: string): Promise<string[]> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.community_id, communityId));
  return rows.map((r) => r.id);
}

export async function listVisibleForUser(communityId: string, userId: string): Promise<ChannelListRow[]> {
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      type: channels.type,
      position: channels.position,
      is_private: channels.is_private,
      channel_member_user_id: channelMembers.user_id,
    })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channel_id, channels.id), eq(channelMembers.user_id, userId)))
    .where(and(eq(channels.community_id, communityId), or(eq(channels.is_private, false), isNotNull(channelMembers.user_id))))
    .orderBy(asc(channels.position), asc(channels.name));

  return rows.map(({ channel_member_user_id, ...ch }) => ({
    ...ch,
    joined: channel_member_user_id != null,
  }));
}

export async function getByIdInCommunity(communityId: string, channelId: string): Promise<{
  id: string;
  community_id: string;
  name: string;
  type: string;
  position: number;
  is_private: boolean;
} | null> {
  const [row] = await db
    .select({
      id: channels.id,
      community_id: channels.community_id,
      name: channels.name,
      type: channels.type,
      position: channels.position,
      is_private: channels.is_private,
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.community_id, communityId)))
    .limit(1);
  return row ?? null;
}

export async function getMaxPosition(communityId: string): Promise<number> {
  const [agg] = await db.select({ mx: max(channels.position) }).from(channels).where(eq(channels.community_id, communityId));
  return Number(agg?.mx ?? -1);
}

export async function createChannel(input: {
  communityId: string;
  name: string;
  type: string;
  position: number;
  isPrivate: boolean;
}): Promise<{
  id: string;
  community_id: string;
  name: string;
  type: string;
  position: number;
  is_private: boolean;
}> {
  const [created] = await db
    .insert(channels)
    .values({
      community_id: input.communityId,
      name: input.name,
      type: input.type,
      position: input.position,
      is_private: input.isPrivate,
    })
    .returning();
  return created;
}

export async function updateChannel(
  channelId: string,
  updates: { name?: string; is_private?: boolean; position?: number }
): Promise<void> {
  await db.update(channels).set(updates).where(eq(channels.id, channelId));
}

export async function getById(channelId: string): Promise<{
  id: string;
  community_id: string;
  name: string;
  type: string;
  position: number;
  is_private: boolean;
} | null> {
  const [row] = await db
    .select({
      id: channels.id,
      community_id: channels.community_id,
      name: channels.name,
      type: channels.type,
      position: channels.position,
      is_private: channels.is_private,
    })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return row ?? null;
}

export async function countByCommunity(communityId: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(channels)
    .where(eq(channels.community_id, communityId));
  return Number(row?.c ?? 0);
}

export async function deleteById(channelId: string): Promise<void> {
  await db.delete(channels).where(eq(channels.id, channelId));
}
