import { types } from "cassandra-driver";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { channelMembers, channels, communityMembers, users } from "./db/schema";
import { cassandra, messagesCassandra, dmsCassandra, readConsistency, writeConsistency } from "./cassandra";
import { env } from "./env";

const readStateKs = env.READ_STATE_CASSANDRA_KEYSPACE;
const messagesKs = env.MESSAGES_CASSANDRA_KEYSPACE;
const dmsKs = env.DMS_CASSANDRA_KEYSPACE;

type ChannelStateRow = {
  channelId: string;
  lastReadMessageId: string | null;
  lastReadTimeuuid: string | null;
  mentionCount: number;
  hasUnread: boolean;
};

type DmStateRow = {
  conversationId: string;
  lastReadMessageId: string | null;
  lastReadTimeuuid: string | null;
  hasUnread: boolean;
};

type DmParticipantReadStateRow = {
  userId: string;
  lastReadMessageId: string | null;
  lastReadTimeuuid: string | null;
};

function toUuid(value: string): types.Uuid {
  return types.Uuid.fromString(value);
}

function toTimeUuid(value: string): types.TimeUuid {
  return types.TimeUuid.fromString(value);
}

function compareTimeuuids(a: string, b: string): number {
  return toTimeUuid(a).getBuffer().compare(toTimeUuid(b).getBuffer());
}

export async function assertChannelAccess(
  userId: string,
  channelId: string
): Promise<
  | { ok: true; channel: { id: string; community_id: string } }
  | { ok: false; status: 404 | 403 }
> {
  const [channel] = await db
    .select({ id: channels.id, community_id: channels.community_id })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return { ok: false, status: 404 };

  const [communityMembership] = await db
    .select({ user_id: communityMembers.user_id })
    .from(communityMembers)
    .where(and(
      eq(communityMembers.community_id, channel.community_id),
      eq(communityMembers.user_id, userId)
    ))
    .limit(1);
  if (!communityMembership) return { ok: false, status: 403 };

  const [channelMembership] = await db
    .select({ user_id: channelMembers.user_id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId)))
    .limit(1);
  if (!channelMembership) return { ok: false, status: 403 };

  return { ok: true, channel };
}

export async function listAccessibleChannelIds(userId: string, communityId: string): Promise<string[]> {
  const [membership] = await db
    .select({ user_id: communityMembers.user_id })
    .from(communityMembers)
    .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
    .limit(1);
  if (!membership) return [];

  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channel_id, channels.id))
    .where(and(eq(channels.community_id, communityId), eq(channelMembers.user_id, userId)));
  return rows.map((row) => row.id);
}

async function isDmParticipant(conversationId: string, userId: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM dm_participants
    WHERE conversation_id = ${conversationId}::uuid
      AND user_id = ${userId}::uuid
    LIMIT 1
  `);
  return result.rows.length > 0;
}

async function listDmParticipantIds(conversationId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT user_id
    FROM dm_participants
    WHERE conversation_id = ${conversationId}::uuid
  `);
  return result.rows.map((row) => String(row.user_id));
}

async function listUserConversationIds(userId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT conversation_id
    FROM dm_participants
    WHERE user_id = ${userId}::uuid
  `);
  return result.rows.map((row) => String(row.conversation_id));
}

export async function getChannelState(userId: string, channelId: string): Promise<ChannelStateRow> {
  const [stateResult, mentionResult, latestResult] = await Promise.all([
    cassandra.execute(
      `SELECT last_read_message_id, last_read_timeuuid FROM ${readStateKs}.channel_state_by_user WHERE user_id = ? AND channel_id = ?`,
      [toUuid(userId), toUuid(channelId)],
      { prepare: true, consistency: readConsistency }
    ),
    cassandra.execute(
      `SELECT mention_count FROM ${readStateKs}.channel_mentions_by_user WHERE user_id = ? AND channel_id = ?`,
      [toUuid(userId), toUuid(channelId)],
      { prepare: true, consistency: readConsistency }
    ),
    messagesCassandra.execute(
      `SELECT message_id, created_at FROM ${messagesKs}.messages_by_channel WHERE channel_id = ? LIMIT 1`,
      [toUuid(channelId)],
      { prepare: true, consistency: readConsistency }
    ),
  ]);

  const stateRow = stateResult.rows[0];
  const mentionRow = mentionResult.rows[0];
  const latestRow = latestResult.rows[0];
  const lastReadMessageId = stateRow?.get("last_read_message_id")?.toString() ?? null;
  const lastReadTimeuuid = stateRow?.get("last_read_timeuuid")?.toString() ?? null;
  const latestTimeuuid = latestRow?.get("created_at")?.toString() ?? null;
  const mentionCount = Number(mentionRow?.get("mention_count") ?? 0);

  return {
    channelId,
    lastReadMessageId,
    lastReadTimeuuid,
    mentionCount,
    hasUnread: latestTimeuuid != null && (!lastReadTimeuuid || compareTimeuuids(latestTimeuuid, lastReadTimeuuid) > 0),
  };
}

export async function getChannelStatesForCommunity(userId: string, communityId: string): Promise<ChannelStateRow[]> {
  const channelIds = await listAccessibleChannelIds(userId, communityId);
  return Promise.all(channelIds.map((channelId) => getChannelState(userId, channelId)));
}

export async function ensureMessageExists(channelId: string, messageId: string, timeuuid: string): Promise<boolean> {
  const result = await messagesCassandra.execute(
    `SELECT message_id FROM ${messagesKs}.messages_by_channel WHERE channel_id = ? AND created_at = ?`,
    [toUuid(channelId), toTimeUuid(timeuuid)],
    { prepare: true, consistency: readConsistency }
  );
  const row = result.rows[0];
  return row?.get("message_id")?.toString() === messageId;
}

export async function markChannelRead(userId: string, channelId: string, messageId: string, timeuuid: string): Promise<boolean> {
  const current = await cassandra.execute(
    `SELECT last_read_timeuuid FROM ${readStateKs}.channel_state_by_user WHERE user_id = ? AND channel_id = ?`,
    [toUuid(userId), toUuid(channelId)],
    { prepare: true, consistency: readConsistency }
  );
  const currentTimeuuid = current.rows[0]?.get("last_read_timeuuid")?.toString() ?? null;
  if (currentTimeuuid && compareTimeuuids(timeuuid, currentTimeuuid) <= 0) {
    return false;
  }

  await cassandra.execute(
    `UPDATE ${readStateKs}.channel_state_by_user
     SET last_read_message_id = ?, last_read_timeuuid = ?, updated_at = toTimestamp(now())
     WHERE user_id = ? AND channel_id = ?`,
    [toUuid(messageId), toTimeUuid(timeuuid), toUuid(userId), toUuid(channelId)],
    { prepare: true, consistency: writeConsistency }
  );

  const mentionResult = await cassandra.execute(
    `SELECT mention_count FROM ${readStateKs}.channel_mentions_by_user WHERE user_id = ? AND channel_id = ?`,
    [toUuid(userId), toUuid(channelId)],
    { prepare: true, consistency: readConsistency }
  );
  const mentionCount = Number(mentionResult.rows[0]?.get("mention_count") ?? 0);
  if (mentionCount > 0) {
    await cassandra.execute(
      `UPDATE ${readStateKs}.channel_mentions_by_user SET mention_count = mention_count - ? WHERE user_id = ? AND channel_id = ?`,
      [mentionCount, toUuid(userId), toUuid(channelId)],
      { prepare: true, consistency: writeConsistency }
    );
  }

  return true;
}

const mentionRegex = /(^|[^\w])@([a-z0-9._-]{1,64})\b/gi;

export async function findMentionedUserIds(channelId: string, content: string): Promise<string[]> {
  const usernames = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(content)) !== null) {
    usernames.add(match[2].toLowerCase());
  }
  if (usernames.size === 0) return [];

  const members = await db
    .select({ user_id: channelMembers.user_id })
    .from(channelMembers)
    .where(eq(channelMembers.channel_id, channelId));
  const userIds = members.map((row) => row.user_id);
  if (userIds.length === 0) return [];

  const rows = await db
    .select({ user_id: users.internal_id, username: users.username })
    .from(users)
    .where(inArray(users.internal_id, userIds));

  return rows
    .filter((row) => usernames.has(row.username.toLowerCase()))
    .map((row) => row.user_id);
}

export async function incrementMentionCounts(channelId: string, authorId: string, content: string): Promise<void> {
  const mentionedUserIds = await findMentionedUserIds(channelId, content);
  await Promise.all(
    mentionedUserIds
      .filter((userId) => userId !== authorId)
      .map((userId) =>
        cassandra.execute(
          `UPDATE ${readStateKs}.channel_mentions_by_user SET mention_count = mention_count + 1 WHERE user_id = ? AND channel_id = ?`,
          [toUuid(userId), toUuid(channelId)],
          { prepare: true, consistency: writeConsistency }
        )
      )
  );
}

export async function getDmState(userId: string, conversationId: string): Promise<DmStateRow> {
  const [stateResult, latestResult] = await Promise.all([
    cassandra.execute(
      `SELECT last_read_message_id, last_read_timeuuid FROM ${readStateKs}.dm_state_by_user WHERE user_id = ? AND conversation_id = ?`,
      [toUuid(userId), toUuid(conversationId)],
      { prepare: true, consistency: readConsistency }
    ),
    dmsCassandra.execute(
      `SELECT message_id, created_at FROM ${dmsKs}.messages_by_conversation WHERE conversation_id = ? LIMIT 1`,
      [toUuid(conversationId)],
      { prepare: true, consistency: readConsistency }
    ),
  ]);

  const stateRow = stateResult.rows[0];
  const latestRow = latestResult.rows[0];
  const lastReadMessageId = stateRow?.get("last_read_message_id")?.toString() ?? null;
  const lastReadTimeuuid = stateRow?.get("last_read_timeuuid")?.toString() ?? null;
  const latestTimeuuid = latestRow?.get("created_at")?.toString() ?? null;

  return {
    conversationId,
    lastReadMessageId,
    lastReadTimeuuid,
    hasUnread: latestTimeuuid != null && (!lastReadTimeuuid || compareTimeuuids(latestTimeuuid, lastReadTimeuuid) > 0),
  };
}

export async function getDmStatesForUser(userId: string): Promise<DmStateRow[]> {
  const conversationIds = await listUserConversationIds(userId);
  return Promise.all(conversationIds.map((conversationId) => getDmState(userId, conversationId)));
}

export async function getDmParticipantReadStates(conversationId: string, requesterId: string): Promise<DmParticipantReadStateRow[]> {
  if (!(await isDmParticipant(conversationId, requesterId))) {
    throw new Error("forbidden");
  }
  const participantIds = await listDmParticipantIds(conversationId);
  const result = await cassandra.execute(
    `SELECT user_id, last_read_message_id, last_read_timeuuid FROM ${readStateKs}.dm_state_by_user WHERE user_id IN ? AND conversation_id = ?`,
    [participantIds.map(toUuid), toUuid(conversationId)],
    { prepare: true, consistency: readConsistency }
  );
  const map = new Map(result.rows.map((row) => [
    row.get("user_id").toString(),
    {
      userId: row.get("user_id").toString(),
      lastReadMessageId: row.get("last_read_message_id")?.toString() ?? null,
      lastReadTimeuuid: row.get("last_read_timeuuid")?.toString() ?? null,
    }
  ]));
  return participantIds.map((userId) => map.get(userId) ?? {
    userId,
    lastReadMessageId: null,
    lastReadTimeuuid: null,
  });
}

export async function getDmMessageIdForTimeuuid(conversationId: string, timeuuid: string): Promise<string | null> {
  const result = await dmsCassandra.execute(
    `SELECT message_id FROM ${dmsKs}.messages_by_conversation WHERE conversation_id = ? AND created_at = ?`,
    [toUuid(conversationId), toTimeUuid(timeuuid)],
    { prepare: true, consistency: readConsistency }
  );
  return result.rows[0]?.get("message_id")?.toString() ?? null;
}

export async function getChannelMessageIdForTimeuuid(channelId: string, timeuuid: string): Promise<string | null> {
  const result = await messagesCassandra.execute(
    `SELECT message_id FROM ${messagesKs}.messages_by_channel WHERE channel_id = ? AND created_at = ?`,
    [toUuid(channelId), toTimeUuid(timeuuid)],
    { prepare: true, consistency: readConsistency }
  );
  return result.rows[0]?.get("message_id")?.toString() ?? null;
}

export async function markDmRead(
  userId: string,
  conversationId: string,
  timeuuid: string,
  messageIdHint?: string
): Promise<boolean> {
  if (!(await isDmParticipant(conversationId, userId))) {
    throw new Error("forbidden");
  }

  const messageId = messageIdHint ?? (await getDmMessageIdForTimeuuid(conversationId, timeuuid));
  if (!messageId) {
    return false;
  }

  const current = await cassandra.execute(
    `SELECT last_read_timeuuid FROM ${readStateKs}.dm_state_by_user WHERE user_id = ? AND conversation_id = ?`,
    [toUuid(userId), toUuid(conversationId)],
    { prepare: true, consistency: readConsistency }
  );
  const currentTimeuuid = current.rows[0]?.get("last_read_timeuuid")?.toString() ?? null;
  if (currentTimeuuid && compareTimeuuids(timeuuid, currentTimeuuid) <= 0) {
    return false;
  }

  await cassandra.execute(
    `UPDATE ${readStateKs}.dm_state_by_user
     SET last_read_message_id = ?, last_read_timeuuid = ?, updated_at = toTimestamp(now())
     WHERE user_id = ? AND conversation_id = ?`,
    [toUuid(messageId), toTimeUuid(timeuuid), toUuid(userId), toUuid(conversationId)],
    { prepare: true, consistency: writeConsistency }
  );
  return true;
}

export async function listDmParticipantIdsForEvent(conversationId: string): Promise<string[]> {
  return listDmParticipantIds(conversationId);
}
