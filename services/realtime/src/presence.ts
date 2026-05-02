import Redis from "ioredis";

export const IDLE_THRESHOLD_MS = 60 * 1000; // 1 minute

export type PresenceStatus = "online" | "idle" | "away" | "offline";

// Set of userIds with at least one active presence:conns:<userId> hash. Lets
// startup/reaper enumerate via SMEMBERS instead of SCAN MATCH presence:conns:*
// — SCAN was a slowlog regular even though call volume was low.
export const PRESENCE_CONNS_INDEX = "presence:conns:index";

export async function registerConnection(redis: Redis, userId: string, connId: string, instanceId: string): Promise<void> {
  // Use 0 as sentinel — connect/reconnect doesn't count as activity per spec
  await redis.multi()
    .hset(`presence:conns:${userId}`, `${instanceId}:${connId}`, 0)
    .sadd(PRESENCE_CONNS_INDEX, userId)
    .exec();
}

export async function removeConnection(redis: Redis, userId: string, connId: string, instanceId: string): Promise<void> {
  const key = `presence:conns:${userId}`;
  const result = await redis.multi().hdel(key, `${instanceId}:${connId}`).hlen(key).exec();
  const remaining = (result?.[1]?.[1] as number) ?? 0;
  if (remaining === 0) {
    // Hash empty → drop from index. DEL is harmless if already gone.
    await redis.multi().del(key).srem(PRESENCE_CONNS_INDEX, userId).exec();
  }
}

/**
 * True if this user still has at least one WS registered on any realtime instance (cluster-wide).
 *
 * When liveInstanceIds is supplied, fields owned by dead instances are ignored. Without that
 * filter, hash entries leaked from prior instance restarts (which use a fresh randomUUID()
 * each boot and therefore never clean up older instances' fields) cause false positives —
 * "user is online" reads true while no live socket actually exists, silently dropping fanout.
 */
export async function hasRegisteredConnections(
  redis: Redis,
  userId: string,
  liveInstanceIds?: Set<string>
): Promise<boolean> {
  const fields = await redis.hkeys(`presence:conns:${userId}`);
  if (!liveInstanceIds) return fields.length > 0;
  return fields.some((f) => liveInstanceIds.has(f.split(":")[0]));
}

export async function updateActivity(redis: Redis, userId: string, connId: string, instanceId: string): Promise<void> {
  await redis.hset(`presence:conns:${userId}`, `${instanceId}:${connId}`, Date.now());
}

export async function setAway(redis: Redis, userId: string, message: string): Promise<void> {
  await redis.set(`presence:away:${userId}`, message);
}

export async function clearAway(redis: Redis, userId: string): Promise<void> {
  await redis.del(`presence:away:${userId}`);
}

export async function computePresence(
  redis: Redis,
  userId: string,
  liveInstanceIds?: Set<string>
): Promise<PresenceStatus> {
  const conns = await redis.hgetall(`presence:conns:${userId}`);
  const allFields = Object.keys(conns);
  const connIds = liveInstanceIds
    ? allFields.filter((f) => liveInstanceIds.has(f.split(":")[0]))
    : allFields;

  if (connIds.length === 0) return "offline";

  const awayMsg = await redis.get(`presence:away:${userId}`);
  if (awayMsg !== null) return "away";

  const now = Date.now();
  const anyRecent = connIds.some((id) => now - Number(conns[id]) < IDLE_THRESHOLD_MS);

  return anyRecent ? "online" : "idle";
}
