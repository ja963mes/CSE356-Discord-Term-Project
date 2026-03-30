/**
 * Redis-backed presence subscription system.
 *
 * Redis keys:
 *   presence:guild:<communityId>   → Set of connected userIds in that community
 *   presence:dm:<conversationId>   → Set of connected userIds in that DM
 *   presence:contexts:<userId>     → Set of "guild:<id>" and "dm:<id>" context keys the user is subscribed to
 *
 * Shard-safe: all state lives in Redis, so multiple realtime instances can fan-out correctly.
 */

import Redis from "ioredis";
import { types as cassandraTypes } from "cassandra-driver";
import { pg, cassandra } from "./db";
import { env } from "./env";

const ks = env.CASSANDRA_KEYSPACE;

const GUILD_KEY = (id: string) => `presence:guild:${id}`;
const DM_KEY = (id: string) => `presence:dm:${id}`;
const CONTEXTS_KEY = (userId: string) => `presence:contexts:${userId}`;

// TTL for context sets — safety net in case disconnect cleanup is missed (e.g. crash)
const CONTEXT_TTL_SEC = 60 * 60 * 24; // 24h

/**
 * Called on user connect.
 * Loads all communities + DM conversations from DB, registers the user
 * in each context set in Redis.
 */
export async function subscribeUser(redis: Redis, userId: string): Promise<void> {
  const [communityIds, conversationIds] = await Promise.all([
    fetchCommunityIds(userId),
    fetchConversationIds(userId),
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
    return type === "guild" ? GUILD_KEY(id) : DM_KEY(id);
  });

  // SUNIONSTORE into a temp key, then read + delete
  // Or just SUNION directly (no temp key needed)
  const members = await redis.sunion(...keys);
  return members;
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

async function fetchConversationIds(userId: string): Promise<string[]> {
  try {
    const uuid = cassandraTypes.Uuid.fromString(userId);
    const result = await cassandra.execute(
      `SELECT conversation_id FROM ${ks}.conversations_by_user WHERE user_id = ?`,
      [uuid],
      { prepare: true }
    );
    return result.rows.map((row) => row.get("conversation_id").toString());
  } catch (err) {
    console.error("[subscriptions] DM fetch failed:", err);
    return [];
  }
}
