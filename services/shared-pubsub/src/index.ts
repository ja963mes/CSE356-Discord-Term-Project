import type { Redis } from "ioredis";

// === Channel constants ===
//
// channel:events — high-volume channel-message broadcast. Sharded across N
// pubsub instances by channelId hash so the single-threaded redis event loop
// doesn't become a fan-out bottleneck.
//
// dm:userfeed:N — per-user shard for direct-message events. Sharded by
// userId so realtime instances handle a slice of fan-out per shard.
//
// dm:events — DM broadcast for non-realtime consumers (search/ES indexing).
// Single un-sharded channel; only one consumer.
//
// community:events / presence:broadcast — single-instance metadata channels.
export const CHANNEL_EVENTS = "channel:events";
export const DM_EVENTS = "dm:events";
export const COMMUNITY_EVENTS = "community:events";
export const PRESENCE_BROADCAST = "presence:broadcast";

export const USER_FEED_SHARD_COUNT = 20;

// === Shard math ===
//
// Bump CHANNEL_PUBSUB_SHARD_COUNT here to change pubsub shard fan-out.
// All publishers + subscribers route through this module, so changes don't
// require touching every service.
export const CHANNEL_PUBSUB_SHARD_COUNT = 2;

/** Returns the pubsub shard index for a given channelId. */
export function channelEventsShard(channelId: string): number {
  let h = 0;
  for (let i = 0; i < channelId.length; i++) {
    h = (h * 31 + channelId.charCodeAt(i)) >>> 0;
  }
  return h % CHANNEL_PUBSUB_SHARD_COUNT;
}

/** Returns the dm:userfeed:N channel name for a given userId. */
export function userFeedChannel(userId: string): string {
  const shard = parseInt(userId.replace(/-/g, "").substring(0, 8), 16) % USER_FEED_SHARD_COUNT;
  return `dm:userfeed:${shard}`;
}

/** All dm:userfeed:* shard channel names — for realtime to subscribe. */
export function userFeedShardChannels(): string[] {
  return Array.from({ length: USER_FEED_SHARD_COUNT }, (_, i) => `dm:userfeed:${i}`);
}

// === Publish helpers ===

/**
 * Publish a channel:events event. `clients` must be in shard order
 * (shard 0 first, shard 1 second, ...). Picks the right client by
 * channelEventsShard(event.channelId).
 *
 * Throws on the final attempt's failure so callers can decide on retries.
 */
export async function publishChannelEvent(
  clients: Redis[],
  channelId: string,
  payload: string
): Promise<void> {
  if (clients.length !== CHANNEL_PUBSUB_SHARD_COUNT) {
    throw new Error(
      `publishChannelEvent: expected ${CHANNEL_PUBSUB_SHARD_COUNT} clients, got ${clients.length}`
    );
  }
  const shard = channelEventsShard(channelId);
  await clients[shard].publish(CHANNEL_EVENTS, payload);
}

// === Subscribe helpers ===

/**
 * Subscribe each client to channel:events. Use this on the consumer side so
 * shard count changes don't require updating every subscriber. Caller still
 * wires the per-client `on("message", handler)` since some services share
 * one handler across multiple subscriptions.
 */
export async function subscribeChannelEvents(clients: Redis[]): Promise<void> {
  if (clients.length !== CHANNEL_PUBSUB_SHARD_COUNT) {
    throw new Error(
      `subscribeChannelEvents: expected ${CHANNEL_PUBSUB_SHARD_COUNT} clients, got ${clients.length}`
    );
  }
  await Promise.all(clients.map((c) => c.subscribe(CHANNEL_EVENTS)));
}
