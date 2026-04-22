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
 * Targets are looked up on the KV instance (presence:contexts:* / presence:guild:* / etc.)
 * and the resulting envelope is published on the pubsub instance.
 */
export async function broadcastPresenceChange(
  kvRedis: Redis,
  pubRedis: Redis,
  userId: string,
  status: PresenceStatus,
  awayMessage?: string
): Promise<void> {
  const targets = await getPresenceTargets(kvRedis, userId);
  // Always include the user themselves
  const targetSet = [...new Set([...targets, userId])];

  const message: PresenceBroadcastMessage = { type: "presence_update", userId, status, awayMessage, targets: targetSet };
  await pubRedis.publish(PRESENCE_BROADCAST_CHANNEL, JSON.stringify(message));
}

export { PRESENCE_BROADCAST_CHANNEL };
