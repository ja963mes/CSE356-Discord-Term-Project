import { redis } from "./redis";

const CHANNEL = "channel:events";

export type ChannelMessageEvent =
  | {
      type: "channel:message:create";
      channelId: string;
      communityId: string;
      message: {
        messageId: string;
        authorId: string;
        authorUsername: string;
        content: string;
        createdAt: string;
      };
    };

export async function publishChannelEvent(event: ChannelMessageEvent): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error("[messages] failed to publish event", event.type, err);
  }
}
