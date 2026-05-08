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
// Per-(user, channel) channel access decision (404/403/ok). Memberships rarely
// change relative to read-state QPS, and the worst case on stale ok is that a
// recently-removed member sees an unread count for ~60s — acceptable for the
// unread-badge UX. On stale 403/404 the user retries naturally. No write-
// through invalidation: the membership tables live in Postgres and are owned
// by other services, so we lean on the short TTL.
const ACCESS_TTL_SEC = 60;

const latestChKey = (channelId: string) => `rs:latest:ch:${channelId}`;
const latestDmKey = (conversationId: string) => `rs:latest:dm:${conversationId}`;
const csKey = (userId: string, channelId: string) => `rs:cs:${userId}:${channelId}`;
const dsKey = (userId: string, conversationId: string) => `rs:ds:${userId}:${conversationId}`;
const mcKey = (userId: string, channelId: string) => `rs:mc:${userId}:${channelId}`;
const accessKey = (userId: string, channelId: string) => `rs:access:${userId}:${channelId}`;

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

type AccessResult =
  | { ok: true; channel: { id: string; community_id: string } }
  | { ok: false; status: 404 | 403 };

// Cache encoding: "ok:<community_uuid>" | "404" | "403". Compact so MGET-style
// reuse stays cheap if we ever batch this lookup.
function decodeCachedAccess(channelId: string, raw: string): AccessResult | null {
  if (raw === "404") return { ok: false, status: 404 };
  if (raw === "403") return { ok: false, status: 403 };
  if (raw.startsWith("ok:")) {
    const community_id = raw.slice(3);
    if (community_id) return { ok: true, channel: { id: channelId, community_id } };
  }
  return null;
}

function encodeAccess(result: AccessResult): string {
  if (result.ok) return `ok:${result.channel.community_id}`;
  return String(result.status);
}

async function computeChannelAccess(userId: string, channelId: string): Promise<AccessResult> {
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

export async function assertChannelAccess(
  userId: string,
  channelId: string
): Promise<AccessResult> {
  const cached = await getCachedString(accessKey(userId, channelId));
  if (cached) {
    const decoded = decodeCachedAccess(channelId, cached);
    if (decoded) return decoded;
  }

  const result = await computeChannelAccess(userId, channelId);
  void setCachedString(accessKey(userId, channelId), encodeAccess(result), ACCESS_TTL_SEC);
  return result;
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
  if (channelIds.length === 0) return [];

  // Batch all per-channel Redis GETs into a single MGET to cut N×3 round-trips
  // (cs/mc/latest per channel) down to one. Cassandra fallbacks for any
  // remaining misses still fan out, but cache hit dominates by design.
  const keys: string[] = [];
  for (const channelId of channelIds) {
    keys.push(csKey(userId, channelId), mcKey(userId, channelId), latestChKey(channelId));
  }

  // On Redis error, fall through to Cassandra for every key — same end-state
  // as the original per-key getCachedString swallowing errors and returning
  // null. A flapping cache will cascade to Cassandra; that risk is preexisting.
  let cached: (string | null)[];
  try {
    cached = await kvCacheRedis.mget(keys);
  } catch {
    cached = new Array(keys.length).fill(null);
  }

  return Promise.all(
    channelIds.map(async (channelId, i) => {
      const cachedState = cached[i * 3];
      const cachedMc = cached[i * 3 + 1];
      const cachedLatest = cached[i * 3 + 2];

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
    })
  );
}

export async function getAllChannelStatesForUser(userId: string): Promise<ChannelStateRow[]> {
  const rows = await db
    .select({ id: channels.id })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channel_id))
    .where(eq(channelMembers.user_id, userId));
  return Promise.all(rows.map((r) => getChannelState(userId, r.id)));
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

async function getCurrentChannelLastRead(userId: string, channelId: string): Promise<string | null> {
  // Cache hit (5min TTL, write-through) avoids the SELECT before UPDATE. Falls
  // back to Cassandra on miss + repopulates so subsequent calls stay hot.
  const cached = await getCachedString(csKey(userId, channelId));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as CachedChannelState;
      return parsed.lastReadTimeuuid;
    } catch { /* fall through */ }
  }
  const state = await fetchAndCacheChannelState(userId, channelId);
  return state.lastReadTimeuuid;
}

async function getCurrentMentionCount(userId: string, channelId: string): Promise<number> {
  const cached = await getCachedString(mcKey(userId, channelId));
  if (cached != null) return Number(cached) || 0;
  return fetchAndCacheMentionCount(userId, channelId);
}

export async function markChannelRead(userId: string, channelId: string, messageId: string, timeuuid: string): Promise<boolean> {
  const currentTimeuuid = await getCurrentChannelLastRead(userId, channelId);
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
  void setCachedString(
    csKey(userId, channelId),
    JSON.stringify({ lastReadMessageId: messageId, lastReadTimeuuid: timeuuid }),
    STATE_TTL_SEC
  );

  const mentionCount = await getCurrentMentionCount(userId, channelId);
  if (mentionCount > 0) {
    await cassandra.execute(
      `UPDATE ${readStateKs}.channel_mentions_by_user SET mention_count = mention_count - ? WHERE user_id = ? AND channel_id = ?`,
      [mentionCount, toUuid(userId), toUuid(channelId)],
      { prepare: true, consistency: writeConsistency }
    );
  }
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

// Mention-increment batching: each mention used to fire one Cassandra UPDATE
// per (user, channel). At 78 msg/sec with multi-mention messages this dominates
// counter-table write load. Coalesce in-process for up to MENTION_FLUSH_MS;
// flush as a single `mention_count = mention_count + N` per pair. On crash
// pending increments are lost — acceptable for unread-badge UX.
const MENTION_FLUSH_MS = 1000;
const pendingMentions = new Map<string, { userId: string; channelId: string; count: number }>();
let mentionFlushTimer: NodeJS.Timeout | null = null;

function scheduleMentionFlush(): void {
  if (mentionFlushTimer != null) return;
  mentionFlushTimer = setTimeout(() => {
    mentionFlushTimer = null;
    void flushPendingMentions();
  }, MENTION_FLUSH_MS);
}

async function flushPendingMentions(): Promise<void> {
  if (pendingMentions.size === 0) return;
  const batch = Array.from(pendingMentions.values());
  pendingMentions.clear();
  await Promise.all(
    batch.map((entry) =>
      cassandra
        .execute(
          `UPDATE ${readStateKs}.channel_mentions_by_user SET mention_count = mention_count + ? WHERE user_id = ? AND channel_id = ?`,
          [entry.count, toUuid(entry.userId), toUuid(entry.channelId)],
          { prepare: true, consistency: writeConsistency }
        )
        .catch((err) => {
          console.error("[read-state] mention flush failed", { ...entry, err });
        })
    )
  );
  await delCached(...batch.map((e) => mcKey(e.userId, e.channelId)));
}

export async function incrementMentionCounts(channelId: string, authorId: string, content: string): Promise<void> {
  const mentionedUserIds = await findMentionedUserIds(channelId, content);
  const targets = mentionedUserIds.filter((userId) => userId !== authorId);
  if (targets.length === 0) return;
  for (const userId of targets) {
    const key = `${userId}:${channelId}`;
    const existing = pendingMentions.get(key);
    if (existing) existing.count += 1;
    else pendingMentions.set(key, { userId, channelId, count: 1 });
  }
  scheduleMentionFlush();
}

export async function flushMentionsForShutdown(): Promise<void> {
  if (mentionFlushTimer != null) {
    clearTimeout(mentionFlushTimer);
    mentionFlushTimer = null;
  }
  await flushPendingMentions();
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

  // Cache hit avoids the SELECT before UPDATE. 5min TTL + write-through means
  // most consecutive mark-reads from the same user pay 0 reads here.
  let currentTimeuuid: string | null = null;
  const cached = await getCachedString(dsKey(userId, conversationId));
  if (cached) {
    try { currentTimeuuid = (JSON.parse(cached) as CachedDmState).lastReadTimeuuid; }
    catch { currentTimeuuid = (await fetchAndCacheDmState(userId, conversationId)).lastReadTimeuuid; }
  } else {
    currentTimeuuid = (await fetchAndCacheDmState(userId, conversationId)).lastReadTimeuuid;
  }
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
