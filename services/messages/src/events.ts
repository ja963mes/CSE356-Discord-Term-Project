import { redis } from "./redis";

const CHANNEL = "channel:events";

export type ChannelMessageEvent =
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
      type: "channel:message:edit";
      channelId: string;
      communityId: string;
      message: {
        messageId: string;
        timeuuid: string;
        authorId: string;
        content: string;
        editedAt: string;
      };
    }
  | {
      type: "channel:message:delete";
      channelId: string;
      communityId: string;
      messageId: string;
      timeuuid: string;
      authorId: string;
      message: {
        messageId: string;
        timeuuid: string;
        authorId: string;
      };
    };

export const publishChannelEvent = async (event: ChannelMessageEvent): Promise<void> => {
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error("[messages] failed to publish event", event.type, err);
  }
};
