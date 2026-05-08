/**
 * Redis-backed presence subscription system.
 *
 * Redis keys:
 *   presence:guild:<communityId>   → Set of connected userIds in that community
 *   presence:dm:<conversationId>   → Set of connected userIds in that DM
 *   presence:channel:<channelId>   → Set of connected userIds in that channel
 *   presence:contexts:<userId>     → Set of "guild:<id>", "dm:<id>", "channel:<id>" context keys the user is subscribed to
 *
 * Shard-safe: all state lives in Redis, so multiple realtime instances can fan-out correctly.
 */

import Redis from "ioredis";
import { pg } from "./db";
import { env } from "./env";
import { logger } from "./logger";

// Defensive cap on SUNION result size. A single user in many large communities
// could otherwise produce a huge target array per presence transition. Log and
// truncate instead of spending CPU on a pathological fan-out.
//
// Raised from 2000 → 10000 after observing real users with ~3300 targets being
// silently truncated, dropping presence events for ~1300 peers and surfacing
// as test/UX delivery failures. 10000 leaves room for legitimate large-
// community membership while still catching truly pathological cases (likely
// a runaway zombie-entry bug in presence:guild:* sets, since those sets have
// no TTL — separate follow-up).
const PRESENCE_TARGETS_MAX = 10000;

const GUILD_KEY = (id: string) => `presence:guild:${id}`;
const DM_KEY = (id: string) => `presence:dm:${id}`;
const CHANNEL_KEY = (id: string) => `presence:channel:${id}`;
const CONTEXTS_KEY = (userId: string) => `presence:contexts:${userId}`;

// TTL for context sets — safety net in case disconnect cleanup is missed (e.g. crash)
const CONTEXT_TTL_SEC = 60 * 60 * 24; // 24h

const PRESENCE_TARGETS_CACHE_TTL_MS = 2000;
type PresenceTargetsCacheEntry = { targets: string[]; expiresAt: number; inflight?: Promise<string[]> };
const presenceTargetsCache = new Map<string, PresenceTargetsCacheEntry>();

export function invalidatePresenceTargetsCache(userId: string): void {
  presenceTargetsCache.delete(userId);
}

/**
 * Called on user connect.
 * Loads all communities + DM conversations from DB, registers the user
 * in each context set in Redis.
 */
export async function subscribeUser(redis: Redis, userId: string): Promise<void> {
  const [communityIds, conversationIds, channelIds] = await Promise.all([
    fetchCommunityIds(userId),
    fetchConversationIds(userId),
    fetchChannelIds(userId),
  ]);

  const pipeline = redis.pipeline();

  for (const id of communityIds) {
    pipeline.sadd(GUILD_KEY(id), userId);
    pipeline.sadd(CONTEXTS_KEY(userId), `guild:${id}`);
  }

  for (const id of conversationIds) {
    pipeline.sadd(DM_KEY(id), userId);
    pipeline.sadd(CONTEXTS_KEY(userId), `dm:${id}`);
  }

  for (const id of channelIds) {
    pipeline.sadd(CHANNEL_KEY(id), userId);
    pipeline.sadd(CONTEXTS_KEY(userId), `channel:${id}`);
  }

  pipeline.expire(CONTEXTS_KEY(userId), CONTEXT_TTL_SEC);

  await pipeline.exec();
}

/**
 * Called on user disconnect.
 * Removes user from all context sets in Redis.
 */
export async function unsubscribeUser(redis: Redis, userId: string): Promise<void> {
  const contexts = await redis.smembers(CONTEXTS_KEY(userId));
  if (contexts.length === 0) return;

  const pipeline = redis.pipeline();

  for (const ctx of contexts) {
    const [type, id] = ctx.split(":");
    if (type === "guild") pipeline.srem(GUILD_KEY(id), userId);
    else if (type === "dm") pipeline.srem(DM_KEY(id), userId);
    else if (type === "channel") pipeline.srem(CHANNEL_KEY(id), userId);
  }

  pipeline.del(CONTEXTS_KEY(userId));
  await pipeline.exec();
}

/**
 * Called when a new DM is created.
 * Adds all connected participants to the DM context set.
 */
export async function subscribeDm(redis: Redis, conversationId: string, participantIds: string[]): Promise<void> {
  const pipeline = redis.pipeline();
  for (const userId of participantIds) {
    pipeline.sadd(DM_KEY(conversationId), userId);
    pipeline.sadd(CONTEXTS_KEY(userId), `dm:${conversationId}`);
    pipeline.expire(CONTEXTS_KEY(userId), CONTEXT_TTL_SEC);
  }
  await pipeline.exec();
}

/**
 * Called when a user leaves a DM.
 * Removes them from that DM's context set.
 */
export async function unsubscribeDm(redis: Redis, conversationId: string, userId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.srem(DM_KEY(conversationId), userId);
  pipeline.srem(CONTEXTS_KEY(userId), `dm:${conversationId}`);
  await pipeline.exec();
}

/**
 * Called when a user joins a community.
 * Adds them to that community's context set.
 */
export async function subscribeCommunity(redis: Redis, communityId: string, userId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.sadd(GUILD_KEY(communityId), userId);
  pipeline.sadd(CONTEXTS_KEY(userId), `guild:${communityId}`);
  pipeline.expire(CONTEXTS_KEY(userId), CONTEXT_TTL_SEC);
  await pipeline.exec();
}

/**
 * Called when a user leaves a community.
 * Removes them from that community's context set.
 */
export async function unsubscribeCommunity(redis: Redis, communityId: string, userId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.srem(GUILD_KEY(communityId), userId);
  pipeline.srem(CONTEXTS_KEY(userId), `guild:${communityId}`);
  await pipeline.exec();
}

/**
 * Returns all userIds that should receive presence updates for a given user.
 * Looks up their context sets, unions all member sets — pure Redis, no DB.
 *
 * Scoping: only guild + dm contexts count as presence targets. Channel contexts
 * are omitted — a user in a channel is always in the parent community, which is
 * already covered by the guild set. Channel member sets stay maintained via
 * subscribeChannel/unsubscribeChannel for message fan-out; this read is the
 * only consumer that drops them.
 */
export async function getPresenceTargets(redis: Redis, userId: string): Promise<string[]> {
  const now = Date.now();
  const hit = presenceTargetsCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.targets;
  if (hit?.inflight) return hit.inflight;

  const inflight = computePresenceTargets(redis, userId).then((targets) => {
    presenceTargetsCache.set(userId, { targets, expiresAt: Date.now() + PRESENCE_TARGETS_CACHE_TTL_MS });
    return targets;
  }).catch((err) => {
    presenceTargetsCache.delete(userId);
    throw err;
  });
  presenceTargetsCache.set(userId, { targets: hit?.targets ?? [], expiresAt: hit?.expiresAt ?? 0, inflight });
  return inflight;
}

async function computePresenceTargets(redis: Redis, userId: string): Promise<string[]> {
  const contexts = await redis.smembers(CONTEXTS_KEY(userId));
  if (contexts.length === 0) return [userId];

  const keys: string[] = [];
  for (const ctx of contexts) {
    const [type, id] = ctx.split(":");
    if (type === "guild") keys.push(GUILD_KEY(id));
    else if (type === "dm") keys.push(DM_KEY(id));
    // channel:* intentionally skipped — parent guild already covers these users
  }
  if (keys.length === 0) return [userId];

  const members = await redis.sunion(...keys);
  if (members.length > PRESENCE_TARGETS_MAX) {
    logger.warn({ userId, size: members.length, cap: PRESENCE_TARGETS_MAX }, "presence targets exceeded cap; truncating");
    return members.slice(0, PRESENCE_TARGETS_MAX);
  }
  return members;
}

/**
 * Called when a user joins a channel (or on connect for existing memberships).
 */
export async function subscribeChannel(redis: Redis, channelId: string, userId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.sadd(CHANNEL_KEY(channelId), userId);
  pipeline.sadd(CONTEXTS_KEY(userId), `channel:${channelId}`);
  pipeline.expire(CONTEXTS_KEY(userId), CONTEXT_TTL_SEC);
  await pipeline.exec();
}

/**
 * Called when a user leaves a channel.
 */
export async function unsubscribeChannel(redis: Redis, channelId: string, userId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.srem(CHANNEL_KEY(channelId), userId);
  pipeline.srem(CONTEXTS_KEY(userId), `channel:${channelId}`);
  await pipeline.exec();
}

/**
 * After joining a community while already connected over WebSocket, DB has new `channel_members`
 * rows but `subscribeUser` already ran — add Redis channel contexts for every channel in this guild.
 */
export async function subscribeAllChannelsForUserInCommunity(
  redis: Redis,
  userId: string,
  communityId: string
): Promise<void> {
  try {
    const result = await pg.query<{ channel_id: string }>(
      `SELECT cm.channel_id
       FROM channel_members cm
       INNER JOIN channels ch ON ch.id = cm.channel_id
       WHERE cm.user_id = $1 AND ch.community_id = $2`,
      [userId, communityId]
    );
    for (const row of result.rows) {
      await subscribeChannel(redis, row.channel_id, userId);
    }
  } catch (err) {
    console.error("[subscriptions] subscribeAllChannelsForUserInCommunity failed:", err);
  }
}

/** When a public channel is created, all members get `channel_members` rows — sync Redis for live message fan-out. */
export async function subscribeAllMembersForChannel(redis: Redis, channelId: string): Promise<void> {
  try {
    const result = await pg.query<{ user_id: string }>(
      `SELECT user_id FROM channel_members WHERE channel_id = $1`,
      [channelId]
    );
    for (const row of result.rows) {
      await subscribeChannel(redis, channelId, row.user_id);
    }
  } catch (err) {
    console.error("[subscriptions] subscribeAllMembersForChannel failed:", err);
  }
}

// --- DB helpers (only called on connect) ---

async function fetchCommunityIds(userId: string): Promise<string[]> {
  try {
    const result = await pg.query<{ community_id: string }>(
      `SELECT community_id FROM community_members WHERE user_id = $1`,
      [userId]
    );
    return result.rows.map((r) => r.community_id);
  } catch (err) {
    console.error("[subscriptions] community fetch failed:", err);
    return [];
  }
}

async function fetchChannelIds(userId: string): Promise<string[]> {
  try {
    const result = await pg.query<{ channel_id: string }>(
      `SELECT channel_id FROM channel_members WHERE user_id = $1`,
      [userId]
    );
    return result.rows.map((r) => r.channel_id);
  } catch (err) {
    console.error("[subscriptions] channel fetch failed:", err);
    return [];
  }
}

async function fetchConversationIds(userId: string): Promise<string[]> {
  try {
    // When DM pruning is on, skip DMs with no activity in the last
    // DORMANT_DM_WINDOW_DAYS. `direct_conversations.updated_at` is touched on
    // every message insert (dms/dm/service.ts:createMessage → touchConversation),
    // so it stands in for "last_message_at". Dormant DMs re-enter presence
    // scope via the dm:message:create shard handler in index.ts.
    if (env.ENABLE_DORMANT_DM_PRUNING) {
      const result = await pg.query<{ conversation_id: string }>(
        `SELECT dp.conversation_id
         FROM dm_participants dp
         INNER JOIN direct_conversations dc ON dc.id = dp.conversation_id
         WHERE dp.user_id = $1
           AND dc.updated_at > now() - ($2 || ' days')::interval`,
        [userId, String(env.DORMANT_DM_WINDOW_DAYS)]
      );
      return result.rows.map((r) => r.conversation_id);
    }
    const result = await pg.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM dm_participants WHERE user_id = $1`,
      [userId]
    );
    return result.rows.map((r) => r.conversation_id);
  } catch (err) {
    console.error("[subscriptions] DM fetch failed:", err);
    return [];
  }
}
