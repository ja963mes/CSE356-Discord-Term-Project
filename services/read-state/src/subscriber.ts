import Redis from "ioredis";
import { CHANNEL_EVENTS, subscribeChannelEvents } from "@discord/pubsub";
import { env } from "./env";
import { incrementMentionCounts } from "./repo";

type ChannelEvent =
  | {
      type: "channel:message:create";
      channelId: string;
      communityId: string;
      message: {
        messageId: string;
        timeuuid: string;
        authorId: string;
        authorUsername: string;
        content: string;
        attachmentKeys: string[];
        createdAt: string;
      };
    }
  | {
      type: "channel:message:edit" | "channel:message:delete";
      channelId: string;
      communityId: string;
    };

// channel:events sharded across REDIS_URL (shard 0) and META_REDIS_URL (shard 1).
// Order MUST match @discord/pubsub channelEventsShard mapping; the shared module
// owns the math so subscribe-side stays in sync with publish-side automatically.
const channelEventClients = [new Redis(env.REDIS_URL), new Redis(env.META_REDIS_URL)];

channelEventClients.forEach((c, i) => {
  c.on("connect", () => console.log(`[read-state] Redis subscriber (shard ${i}) connected`));
  c.on("error", (err) => console.error(`[read-state] Redis subscriber (shard ${i}) error:`, err));
});

async function handleChannelEvent(event: ChannelEvent): Promise<void> {
  if (event.type !== "channel:message:create") return;
  await incrementMentionCounts(event.channelId, event.message.authorId, event.message.content);
}

function onMessage(channel: string, message: string): void {
  if (channel !== CHANNEL_EVENTS) return;

  let parsed: ChannelEvent;
  try {
    parsed = JSON.parse(message) as ChannelEvent;
  } catch {
    console.error("[read-state] Failed to parse channel event payload");
    return;
  }

  void handleChannelEvent(parsed).catch((err) => {
    console.error("[read-state] Error handling event", parsed.type, err);
  });
}

export async function startSubscriber(): Promise<void> {
  await subscribeChannelEvents(channelEventClients);
  channelEventClients.forEach((c) => c.on("message", onMessage));
  console.log(`[read-state] Subscribed to ${CHANNEL_EVENTS} on ${channelEventClients.length} shards`);
}
