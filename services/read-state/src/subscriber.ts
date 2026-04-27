import Redis from "ioredis";
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

// channel:events sharded across REDIS_URL (even-hashed) and META_REDIS_URL
// (odd-hashed) by messages service. Subscribe to both or lose half the events.
const sub = new Redis(env.REDIS_URL);
const metaSub = new Redis(env.META_REDIS_URL);

sub.on("connect", () => console.log("[read-state] Redis subscriber connected"));
sub.on("error", (err) => console.error("[read-state] Redis subscriber error:", err));
metaSub.on("connect", () => console.log("[read-state] Redis meta subscriber connected"));
metaSub.on("error", (err) => console.error("[read-state] Redis meta subscriber error:", err));

async function handleChannelEvent(event: ChannelEvent): Promise<void> {
  if (event.type !== "channel:message:create") return;
  await incrementMentionCounts(event.channelId, event.message.authorId, event.message.content);
}

function onMessage(channel: string, message: string): void {
  if (channel !== "channel:events") return;

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
  await sub.subscribe("channel:events");
  sub.on("message", onMessage);
  await metaSub.subscribe("channel:events");
  metaSub.on("message", onMessage);
  console.log("[read-state] Subscribed to channel:events on both pubsub shards");
}
