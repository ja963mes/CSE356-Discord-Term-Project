import { createHash } from "crypto";
import { redis } from "./redis";
import { logger } from "./logger";

/** Seconds */
const TTL_SEARCH = 90;
const TTL_USER_COMMUNITIES = 90;
const TTL_CHANNELS = 120;
const TTL_MEMBERS = 120;

/** Keep epoch key strings aligned with `services/create-community/src/invalidateCommunitiesCache.ts`. */
function keyEpochUcl(userId: string): string {
  return `comm:e:ucl:${userId}`;
}
function keyEpochMem(communityId: string): string {
  return `comm:e:mem:${communityId}`;
}
function keyEpochCh(communityId: string): string {
  return `comm:e:ch:${communityId}`;
}

export async function getUserCommunityEpoch(userId: string): Promise<string> {
  try {
    const v = await redis.get(keyEpochUcl(userId));
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function getCommunityMemEpoch(communityId: string): Promise<string> {
  try {
    const v = await redis.get(keyEpochMem(communityId));
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function getCommunityChEpoch(communityId: string): Promise<string> {
  try {
    const v = await redis.get(keyEpochCh(communityId));
    return v ?? "0";
  } catch {
    return "0";
  }
}

export async function bumpUserCommunityEpoch(userId: string): Promise<void> {
  try {
    await redis.incr(keyEpochUcl(userId));
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
    const p = redis.pipeline();
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

export async function getCachedJson<T>(key: string): Promise<T | null> {
  try {
    const s = await redis.get(key);
    if (s == null) return null;
    return JSON.parse(s) as T;
  } catch (e) {
    logger.debug({ err: e, key }, "readCache: get failed");
    return null;
  }
}

export async function setCachedJson(key: string, ttlSec: number, value: unknown): Promise<void> {
  try {
    await redis.setex(key, ttlSec, JSON.stringify(value));
  } catch (e) {
    logger.debug({ err: e, key }, "readCache: set failed");
  }
}

const SEARCH_LOCK_SEC = 10;
const SEARCH_WAIT_MS = 4000;
const SEARCH_POLL_MS = 20;

/**
 * On cache miss, only one concurrent request runs `factory`; others wait for Redis JSON
 * (reduces Postgres stampedes for the same q/limit, e.g. many tabs or retried requests).
 */
export async function loadSearchCommunitiesCoalesced<T extends { query: string; communities: unknown[] }>(
  cacheKey: string,
  ttlSec: number,
  factory: () => Promise<T>,
): Promise<T> {
  const cached = await getCachedJson<T>(cacheKey);
  if (cached) return cached;

  const lockKey = `${cacheKey}:sf`;
  let acquired = false;
  try {
    const ok = await redis.set(lockKey, "1", "EX", SEARCH_LOCK_SEC, "NX").catch(() => null);
    if (ok === "OK") {
      acquired = true;
      const data = await factory();
      await setCachedJson(cacheKey, ttlSec, data);
      return data;
    }
  } catch (e) {
    logger.warn({ err: e, cacheKey }, "readCache: search coalesce primary path failed");
    if (!acquired) {
      return factory();
    }
    throw e;
  } finally {
    if (acquired) {
      await redis.del(lockKey).catch(() => {});
    }
  }

  const deadline = Date.now() + SEARCH_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, SEARCH_POLL_MS));
    const again = await getCachedJson<T>(cacheKey);
    if (again) return again;
    const lockHeld = await redis.exists(lockKey);
    if (lockHeld === 0) {
      const after = await getCachedJson<T>(cacheKey);
      if (after) return after;
      break;
    }
  }

  const data = await factory();
  void setCachedJson(cacheKey, ttlSec, data);
  return data;
}

export function searchCacheKey(q: string, limit: number): string {
  const h = createHash("sha256").update(`${q}\0${limit}`).digest("hex").slice(0, 40);
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
