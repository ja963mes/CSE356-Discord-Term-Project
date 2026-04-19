import Redis from "ioredis";

const IDLE_THRESHOLD_MS = 60 * 1000; // 1 minute

export type PresenceStatus = "online" | "idle" | "away" | "offline";

export async function registerConnection(redis: Redis, userId: string, connId: string, instanceId: string): Promise<void> {
  // Use 0 as sentinel — connect/reconnect doesn't count as activity per spec
  await redis.hset(`presence:conns:${userId}`, `${instanceId}:${connId}`, 0);
}

export async function removeConnection(redis: Redis, userId: string, connId: string, instanceId: string): Promise<void> {
  await redis.hdel(`presence:conns:${userId}`, `${instanceId}:${connId}`);
}

/** True if this user still has at least one WS registered on any realtime instance (cluster-wide). */
export async function hasRegisteredConnections(redis: Redis, userId: string): Promise<boolean> {
  return (await redis.hlen(`presence:conns:${userId}`)) > 0;
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

export async function computePresence(redis: Redis, userId: string): Promise<PresenceStatus> {
  const conns = await redis.hgetall(`presence:conns:${userId}`);
  const connIds = Object.keys(conns);

  if (connIds.length === 0) return "offline";

  const awayMsg = await redis.get(`presence:away:${userId}`);
  if (awayMsg !== null) return "away";

  const now = Date.now();
  const anyRecent = connIds.some((id) => now - Number(conns[id]) < IDLE_THRESHOLD_MS);

  return anyRecent ? "online" : "idle";
}
