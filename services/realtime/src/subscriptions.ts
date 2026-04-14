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

const GUILD_KEY = (id: string) => `presence:guild:${id}`;
const DM_KEY = (id: string) => `presence:dm:${id}`;
const CHANNEL_KEY = (id: string) => `presence:channel:${id}`;
const CONTEXTS_KEY = (userId: string) => `presence:contexts:${userId}`;

// TTL for context sets — safety net in case disconnect cleanup is missed (e.g. crash)
const CONTEXT_TTL_SEC = 60 * 60 * 24; // 24h

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
 */
export async function getPresenceTargets(redis: Redis, userId: string): Promise<string[]> {
  const contexts = await redis.smembers(CONTEXTS_KEY(userId));
  if (contexts.length === 0) return [userId];

  const keys = contexts.map((ctx) => {
    const [type, id] = ctx.split(":");
    if (type === "guild") return GUILD_KEY(id);
    if (type === "dm") return DM_KEY(id);
    return CHANNEL_KEY(id);
  });

  // SUNIONSTORE into a temp key, then read + delete
  // Or just SUNION directly (no temp key needed)
  const members = await redis.sunion(...keys);
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
