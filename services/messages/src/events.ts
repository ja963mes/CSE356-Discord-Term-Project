import { redis } from "./redis";
import { logger } from "./logger";

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
      id: string;
      timeuuid: string;
      authorId: string;
      message: {
        id: string;
        messageId: string;
        timeuuid: string;
        authorId: string;
      };
    };

export const publishChannelEvent = async (event: ChannelMessageEvent): Promise<void> => {
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.error({ err, eventType: event.type }, "failed to publish channel event");
  }
};
