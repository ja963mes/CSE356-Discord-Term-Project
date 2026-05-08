import { createHash } from "crypto";
import { kvCacheRedis } from "./redis";
import { logger } from "./logger";

/** Seconds */
const TTL_SEARCH = 45;
const TTL_USER_COMMUNITIES = 90;
const TTL_CHANNELS = 120;
const TTL_MEMBERS = 120;

function keyEpochUcl(userId: string): string {
  return `comm:e:ucl:${userId}`;
}
function keyEpochMem(communityId: string): string {
  return `comm:e:mem:${communityId}`;
}
function keyEpochCh(communityId: string): string {
  return `comm:e:ch:${communityId}`;
}

/** Bumped when the public directory index changes. */
function keyEpochDir(): string {
  return `comm:e:dir`;
}

export async function getDirectorySearchEpoch(): Promise<string> {
  try {
    const v = await kvCacheRedis.get(keyEpochDir());
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function getUserCommunityEpoch(userId: string): Promise<string> {
  try {
    const v = await kvCacheRedis.get(keyEpochUcl(userId));
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function getCommunityMemEpoch(communityId: string): Promise<string> {
  try {
    const v = await kvCacheRedis.get(keyEpochMem(communityId));
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function getCommunityChEpoch(communityId: string): Promise<string> {
  try {
    const v = await kvCacheRedis.get(keyEpochCh(communityId));
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function bumpUserCommunityEpoch(userId: string): Promise<void> {
  try {
    await kvCacheRedis.incr(keyEpochUcl(userId));
  } catch (e) {
    logger.warn({ err: e }, "readCache: bump ucl epoch failed");
  }
}

/** Bump membership- and/or channel-list epochs for a community (invalidates per-user channel caches). */
export async function bumpCommunityEpochs(
  communityId: string,
  which: { mem?: boolean; ch?: boolean }
): Promise<void> {
  try {
    const p = kvCacheRedis.pipeline();
    if (which.mem) p.incr(keyEpochMem(communityId));
    if (which.ch) p.incr(keyEpochCh(communityId));
    await p.exec();
  } catch (e) {
    logger.warn({ err: e, communityId }, "readCache: bump community epochs failed");
  }
}

export async function bumpAllForUserCommunity(userId: string, communityId: string): Promise<void> {
  await Promise.all([
    bumpUserCommunityEpoch(userId),
    bumpCommunityEpochs(communityId, { mem: true, ch: true }),
  ]);
}

/**
 * Single-pipeline bump for the create-community path: ucl + mem + ch + dir in
 * one round trip. The dir epoch invalidates `/search-communities` Redis cache
 * so newly-created guilds appear before the 45s TTL expires.
 */
export async function bumpAfterCommunityCreate(userId: string, communityId: string): Promise<void> {
  try {
    const p = kvCacheRedis.pipeline();
    p.incr(keyEpochUcl(userId));
    p.incr(keyEpochMem(communityId));
    p.incr(keyEpochCh(communityId));
    p.incr(keyEpochDir());
    await p.exec();
  } catch (e) {
    logger.warn({ err: e, userId, communityId }, "readCache: bump after community create failed");
  }
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  try {
    const s = await kvCacheRedis.get(key);
    if (s == null) return null;
    return JSON.parse(s) as T;
  } catch (e) {
    logger.debug({ err: e, key }, "readCache: get failed");
    return null;
  }
}

export async function setCachedJson(key: string, ttlSec: number, value: unknown): Promise<void> {
  try {
    await kvCacheRedis.setex(key, ttlSec, JSON.stringify(value));
  } catch (e) {
    logger.debug({ err: e, key }, "readCache: set failed");
  }
}

export function searchCacheKey(epoch: string, q: string, limit: number): string {
  const h = createHash("sha256").update(`${epoch}\0${q}\0${limit}`).digest("hex").slice(0, 40);
  return `comm:c:sc:${h}`;
}

export function userCommunitiesCacheKey(userId: string, epoch: string): string {
  return `comm:c:ucl:${userId}:${epoch}`;
}

export function channelsCacheKey(communityId: string, userId: string, epoch: string): string {
  return `comm:c:ch:${communityId}:${userId}:${epoch}`;
}

export function membersCacheKey(communityId: string, epoch: string): string {
  return `comm:c:mem:${communityId}:${epoch}`;
}

export const cacheTtl = {
  search: TTL_SEARCH,
  userCommunities: TTL_USER_COMMUNITIES,
  channels: TTL_CHANNELS,
  members: TTL_MEMBERS,
} as const;
