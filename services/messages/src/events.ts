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
  const payload = JSON.stringify(event);
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await redis.publish(CHANNEL, payload);
      if (attempt > 1) logger.info({ eventType: event.type, attempt }, "channel event published after retry");
      return;
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const backoff = Math.min(50 * 2 ** (attempt - 1), 500);
      logger.warn({ err, eventType: event.type, attempt, backoff }, "channel event publish failed; retrying");
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  logger.error({ err: lastErr, eventType: event.type, attempts: maxAttempts }, "channel event publish failed after retries");
};
