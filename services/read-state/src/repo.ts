import { types } from "cassandra-driver";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { channelMembers, channels, communityMembers, users } from "./db/schema";
import { cassandra, messagesCassandra, dmsCassandra, readConsistency, writeConsistency } from "./cassandra";
import { env } from "./env";
import { kvCacheRedis } from "./redis";

const readStateKs = env.READ_STATE_CASSANDRA_KEYSPACE;
const messagesKs = env.MESSAGES_CASSANDRA_KEYSPACE;
const dmsKs = env.DMS_CASSANDRA_KEYSPACE;

// rs:latest:* refreshed on every insert by messages/dms services. Long TTL —
// only repopulated from Cassandra on cold start or after eviction.
const LATEST_TTL_SEC = 7 * 24 * 60 * 60;
// Per-(user, channel|conversation) cached state + mention count. Short-ish TTL
// + write-through invalidation. Most channels have no mark-read between polls,
// so cache hit rate dominates Cassandra load reduction.
const STATE_TTL_SEC = 5 * 60;

const latestChKey = (channelId: string) => `rs:latest:ch:${channelId}`;
const latestDmKey = (conversationId: string) => `rs:latest:dm:${conversationId}`;
const csKey = (userId: string, channelId: string) => `rs:cs:${userId}:${channelId}`;
const dsKey = (userId: string, conversationId: string) => `rs:ds:${userId}:${conversationId}`;
const mcKey = (userId: string, channelId: string) => `rs:mc:${userId}:${channelId}`;

type CachedChannelState = { lastReadMessageId: string | null; lastReadTimeuuid: string | null };
type CachedDmState = { lastReadMessageId: string | null; lastReadTimeuuid: string | null };

async function getCachedString(key: string): Promise<string | null> {
  try { return await kvCacheRedis.get(key); } catch { return null; }
}

async function setCachedString(key: string, value: string, ttlSec: number): Promise<void> {
  try { await kvCacheRedis.set(key, value, "EX", ttlSec); } catch { /* best-effort */ }
}

async function delCached(...keys: string[]): Promise<void> {
  try { await kvCacheRedis.del(...keys); } catch { /* best-effort */ }
}

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

async function fetchAndCacheChannelState(userId: string, channelId: string): Promise<CachedChannelState> {
  const result = await cassandra.execute(
    `SELECT last_read_message_id, last_read_timeuuid FROM ${readStateKs}.channel_state_by_user WHERE user_id = ? AND channel_id = ?`,
    [toUuid(userId), toUuid(channelId)],
    { prepare: true, consistency: readConsistency }
  );
  const row = result.rows[0];
  const state: CachedChannelState = {
    lastReadMessageId: row?.get("last_read_message_id")?.toString() ?? null,
    lastReadTimeuuid: row?.get("last_read_timeuuid")?.toString() ?? null,
  };
  await setCachedString(csKey(userId, channelId), JSON.stringify(state), STATE_TTL_SEC);
  return state;
}

async function fetchAndCacheMentionCount(userId: string, channelId: string): Promise<number> {
  const result = await cassandra.execute(
    `SELECT mention_count FROM ${readStateKs}.channel_mentions_by_user WHERE user_id = ? AND channel_id = ?`,
    [toUuid(userId), toUuid(channelId)],
    { prepare: true, consistency: readConsistency }
  );
  const count = Number(result.rows[0]?.get("mention_count") ?? 0);
  await setCachedString(mcKey(userId, channelId), String(count), STATE_TTL_SEC);
  return count;
}

async function fetchAndCacheLatestChannelTimeuuid(channelId: string): Promise<string | null> {
  const result = await messagesCassandra.execute(
    `SELECT created_at FROM ${messagesKs}.messages_by_channel WHERE channel_id = ? LIMIT 1`,
    [toUuid(channelId)],
    { prepare: true, consistency: readConsistency }
  );
  const t = result.rows[0]?.get("created_at")?.toString() ?? null;
  if (t) await setCachedString(latestChKey(channelId), t, LATEST_TTL_SEC);
  return t;
}

async function fetchAndCacheLatestDmTimeuuid(conversationId: string): Promise<string | null> {
  const result = await dmsCassandra.execute(
    `SELECT created_at FROM ${dmsKs}.messages_by_conversation WHERE conversation_id = ? LIMIT 1`,
    [toUuid(conversationId)],
    { prepare: true, consistency: readConsistency }
  );
  const t = result.rows[0]?.get("created_at")?.toString() ?? null;
  if (t) await setCachedString(latestDmKey(conversationId), t, LATEST_TTL_SEC);
  return t;
}

export async function getChannelState(userId: string, channelId: string): Promise<ChannelStateRow> {
  const [cachedState, cachedMc, cachedLatest] = await Promise.all([
    getCachedString(csKey(userId, channelId)),
    getCachedString(mcKey(userId, channelId)),
    getCachedString(latestChKey(channelId)),
  ]);

  const fallbacks: Promise<unknown>[] = [];
  let state: CachedChannelState;
  if (cachedState) {
    try { state = JSON.parse(cachedState) as CachedChannelState; }
    catch { state = await fetchAndCacheChannelState(userId, channelId); }
  } else {
    fallbacks.push(fetchAndCacheChannelState(userId, channelId));
    state = { lastReadMessageId: null, lastReadTimeuuid: null };
  }

  let mentionCount: number;
  if (cachedMc != null) {
    mentionCount = Number(cachedMc) || 0;
  } else {
    fallbacks.push(fetchAndCacheMentionCount(userId, channelId));
    mentionCount = 0;
  }

  let latestTimeuuid = cachedLatest;
  if (latestTimeuuid == null) {
    fallbacks.push(fetchAndCacheLatestChannelTimeuuid(channelId));
  }

  if (fallbacks.length > 0) {
    const settled = await Promise.all(fallbacks);
    let idx = 0;
    if (!cachedState) state = settled[idx++] as CachedChannelState;
    if (cachedMc == null) mentionCount = settled[idx++] as number;
    if (latestTimeuuid == null) latestTimeuuid = settled[idx++] as string | null;
  }

  return {
    channelId,
    lastReadMessageId: state.lastReadMessageId,
    lastReadTimeuuid: state.lastReadTimeuuid,
    mentionCount,
    hasUnread:
      latestTimeuuid != null &&
      (!state.lastReadTimeuuid || compareTimeuuids(latestTimeuuid, state.lastReadTimeuuid) > 0),
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
  // Write-through cache so the next getChannelState skips the Cassandra read.
  void setCachedString(
    csKey(userId, channelId),
    JSON.stringify({ lastReadMessageId: messageId, lastReadTimeuuid: timeuuid }),
    STATE_TTL_SEC
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
  // Mention count is now zero (or already was). Cache directly.
  void setCachedString(mcKey(userId, channelId), "0", STATE_TTL_SEC);

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
  const targets = mentionedUserIds.filter((userId) => userId !== authorId);
  if (targets.length === 0) return;
  await Promise.all(
    targets.map((userId) =>
      cassandra.execute(
        `UPDATE ${readStateKs}.channel_mentions_by_user SET mention_count = mention_count + 1 WHERE user_id = ? AND channel_id = ?`,
        [toUuid(userId), toUuid(channelId)],
        { prepare: true, consistency: writeConsistency }
      )
    )
  );
  // Invalidate cached mention_count for affected users — next read repopulates
  // from the (now fresh) counter row.
  void delCached(...targets.map((u) => mcKey(u, channelId)));
}

async function fetchAndCacheDmState(userId: string, conversationId: string): Promise<CachedDmState> {
  const result = await cassandra.execute(
    `SELECT last_read_message_id, last_read_timeuuid FROM ${readStateKs}.dm_state_by_user WHERE user_id = ? AND conversation_id = ?`,
    [toUuid(userId), toUuid(conversationId)],
    { prepare: true, consistency: readConsistency }
  );
  const row = result.rows[0];
  const state: CachedDmState = {
    lastReadMessageId: row?.get("last_read_message_id")?.toString() ?? null,
    lastReadTimeuuid: row?.get("last_read_timeuuid")?.toString() ?? null,
  };
  await setCachedString(dsKey(userId, conversationId), JSON.stringify(state), STATE_TTL_SEC);
  return state;
}

export async function getDmState(userId: string, conversationId: string): Promise<DmStateRow> {
  const [cachedState, cachedLatest] = await Promise.all([
    getCachedString(dsKey(userId, conversationId)),
    getCachedString(latestDmKey(conversationId)),
  ]);

  const fallbacks: Promise<unknown>[] = [];
  let state: CachedDmState;
  if (cachedState) {
    try { state = JSON.parse(cachedState) as CachedDmState; }
    catch { state = await fetchAndCacheDmState(userId, conversationId); }
  } else {
    fallbacks.push(fetchAndCacheDmState(userId, conversationId));
    state = { lastReadMessageId: null, lastReadTimeuuid: null };
  }

  let latestTimeuuid = cachedLatest;
  if (latestTimeuuid == null) {
    fallbacks.push(fetchAndCacheLatestDmTimeuuid(conversationId));
  }

  if (fallbacks.length > 0) {
    const settled = await Promise.all(fallbacks);
    let idx = 0;
    if (!cachedState) state = settled[idx++] as CachedDmState;
    if (latestTimeuuid == null) latestTimeuuid = settled[idx++] as string | null;
  }

  return {
    conversationId,
    lastReadMessageId: state.lastReadMessageId,
    lastReadTimeuuid: state.lastReadTimeuuid,
    hasUnread:
      latestTimeuuid != null &&
      (!state.lastReadTimeuuid || compareTimeuuids(latestTimeuuid, state.lastReadTimeuuid) > 0),
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
    `SELECT message_id, author_id FROM ${dmsKs}.messages_by_conversation WHERE conversation_id = ? AND created_at = ?`,
    [toUuid(conversationId), toTimeUuid(timeuuid)],
    { prepare: true, consistency: readConsistency }
  );
  const row = result.rows[0];
  if (!row || row.get("author_id") == null) return null;
  return row.get("message_id")?.toString() ?? null;
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
  void setCachedString(
    dsKey(userId, conversationId),
    JSON.stringify({ lastReadMessageId: messageId, lastReadTimeuuid: timeuuid }),
    STATE_TTL_SEC
  );
  return true;
}

export async function listDmParticipantIdsForEvent(conversationId: string): Promise<string[]> {
  return listDmParticipantIds(conversationId);
}
