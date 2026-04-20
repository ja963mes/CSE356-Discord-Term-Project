import { redis } from "./redis";
import { logger } from "./logger";

const CHANNEL = "dm:events";

export type DmEvent =
  | {
      type: "dm:conversation:create";
      conversationId: string;
      participantIds: string[];
      conversation: {
        conversationId: string;
        conversationType: "one_to_one" | "group";
        name: string | null;
        participantIds: string[];
        createdAt: string;
        updatedAt: string;
      };
    }
  | {
      type: "dm:message:create";
      conversationId: string;
      participantIds: string[];
      message: {
        messageId: string;
        authorId: string;
        content: string;
        attachments: string[];
        createdAt: string;
        timeuuid: string;
      };
    }
  | {
      type: "dm:message:edit";
      conversationId: string;
      participantIds: string[];
      message: {
        messageId: string;
        authorId: string;
        content: string;
        createdAt: string;
        updatedAt: string;
        timeuuid: string;
      };
    }
  | {
      type: "dm:message:delete";
      conversationId: string;
      participantIds: string[];
      messageId: string;
      id: string;
      authorId: string;
      timeuuid: string;
      message: {
        id: string;
        messageId: string;
        timeuuid: string;
        authorId: string;
      };
    }
  | {
      type: "dm:participant:join";
      conversationId: string;
      participantIds: string[];
      userId: string;
    }
  | {
      type: "dm:participant:leave";
      conversationId: string;
      participantIds: string[];
      userId: string;
      conversationDeleted: boolean;
    }
  | {
      type: "dm:read-state:update";
      conversationId: string;
      participantIds: string[];
      userId: string;
      messageId: string;
      timeuuid: string;
    };

export async function publishDmEvent(event: DmEvent): Promise<void> {
  if (event.type === "dm:message:create") {
    logger.info(
      {
        conversationId: event.conversationId,
        messageId: event.message.messageId,
        authorId: event.message.authorId,
        participantIds: event.participantIds,
        participantCount: event.participantIds.length,
        createdAt: event.message.createdAt,
        timeuuid: event.message.timeuuid,
      },
      "dm:message:create publishing to redis"
    );
  }
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
    if (event.type === "dm:message:create") {
      logger.info(
        { conversationId: event.conversationId, messageId: event.message.messageId },
        "dm:message:create published to redis"
      );
    }
  } catch (err) {
    logger.error({ err, eventType: event.type, conversationId: event.conversationId }, "redis publish failed");
    throw err;
  }
}
