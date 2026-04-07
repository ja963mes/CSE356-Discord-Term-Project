import Redis from "ioredis";
import { PresenceStatus } from "./presence";
import { getPresenceTargets } from "./subscriptions";

const PRESENCE_BROADCAST_CHANNEL = "presence:broadcast";

export type PresenceBroadcastMessage = {
  type: "presence_update";
  userId: string;
  status: PresenceStatus;
  awayMessage?: string;
  targets: string[]; // pre-computed target set so each shard doesn't re-query
};

/**
 * Publishes a presence change to the shared Redis channel.
 * All realtime instances subscribe and deliver to their local connections.
 */
export async function broadcastPresenceChange(
  redis: Redis,
  userId: string,
  status: PresenceStatus,
  awayMessage?: string
): Promise<void> {
  const targets = await getPresenceTargets(redis, userId);
  // Always include the user themselves
  const targetSet = [...new Set([...targets, userId])];

  const message: PresenceBroadcastMessage = { type: "presence_update", userId, status, awayMessage, targets: targetSet };
  await redis.publish(PRESENCE_BROADCAST_CHANNEL, JSON.stringify(message));
}

export { PRESENCE_BROADCAST_CHANNEL };
