import { redis } from "./redis";

/**
 * Key names must match services/communities/src/readCache.ts epoch keys.
 * Bump after creating a community so GET /communities /channels /members see fresh data.
 */
function keyEpochUcl(userId: string): string {
  return `comm:e:ucl:${userId}`;
}
function keyEpochMem(communityId: string): string {
  return `comm:e:mem:${communityId}`;
}
function keyEpochCh(communityId: string): string {
  return `comm:e:ch:${communityId}`;
}

export async function bumpCommunitiesReadCacheAfterCreate(userId: string, communityId: string): Promise<void> {
  try {
    const p = redis.pipeline();
    p.incr(keyEpochUcl(userId));
    p.incr(keyEpochMem(communityId));
    p.incr(keyEpochCh(communityId));
    await p.exec();
  } catch (e) {
    console.warn("[create-community] communities read-cache bump failed", e);
  }
}
