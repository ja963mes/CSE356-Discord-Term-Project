import { redis } from "./redis";
import { logger } from "./logger";

const CHANNEL = "dm:events";

/**
 * Outbound-queue parameters. Each participant has a capped Redis list of
 * pending dm:new_message hints. Realtime drains this list on WS connect so
 * that hints dispatched while a socket was tearing down are still delivered
 * on the next reconnect, without waiting for Cassandra catch-up.
 */
const PENDING_KEY_PREFIX = "dm:pending:";
const PENDING_MAX_PER_USER = 100;
const PENDING_TTL_SECONDS = 3600;

/**
 * Direct HTTP fanout — parallel to redis pubsub. Each realtime instance
 * self-registers under `realtime:instances` hash on startup. We HGETALL and
 * POST the event to every instance's /internal/deliver-dm in parallel. Redis
 * pubsub remains the durability backstop; this path trades one extra HTTP
 * hop for lower cross-VM latency variance. Client dedupes by messageId.
 */
const INSTANCE_REGISTRY_KEY = "realtime:instances";
const DIRECT_FANOUT_TIMEOUT_MS = 500;

async function directHttpFanout(event: DmEvent): Promise<void> {
  let instances: Record<string, string>;
  try {
    instances = await redis.hgetall(INSTANCE_REGISTRY_KEY);
  } catch (err) {
    logger.warn({ err, eventType: event.type }, "direct fanout: instance registry read failed");
    return;
  }
  const entries = Object.entries(instances);
  if (entries.length === 0) return;

  const body = JSON.stringify({ event });
  await Promise.all(
    entries.map(async ([instanceId, url]) => {
      if (!url) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DIRECT_FANOUT_TIMEOUT_MS);
      try {
        const res = await fetch(`${url}/internal/deliver-dm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          logger.warn(
            { instanceId, url, status: res.status, eventType: event.type },
            "direct fanout: non-2xx response"
          );
        }
      } catch (err) {
        // Instance down or slow. Pubsub is still the fallback path.
        logger.warn({ err, instanceId, url, eventType: event.type }, "direct fanout: POST failed");
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

async function enqueuePendingDmHint(
  participantIds: string[],
  hint: { type: "dm:new_message"; conversationId: string; messageId: string; authorId: string; timeuuid: string }
): Promise<void> {
  if (participantIds.length === 0) return;
  const payload = JSON.stringify(hint);
  const pipeline = redis.pipeline();
  for (const userId of participantIds) {
    const key = `${PENDING_KEY_PREFIX}${userId}`;
    pipeline.lpush(key, payload);
    pipeline.ltrim(key, 0, PENDING_MAX_PER_USER - 1);
    pipeline.expire(key, PENDING_TTL_SECONDS);
  }
  try {
    await pipeline.exec();
  } catch (err) {
    logger.warn(
      { err, conversationId: hint.conversationId, messageId: hint.messageId, participantCount: participantIds.length },
      "dm pending-queue enqueue failed"
    );
  }
}

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
      // Queue a minimal hint per participant so realtime can drain it on
      // the next WS connect even if the live fanout raced with a socket
      // tearing down. Clients dedupe by messageId, so overlap with the
      // live send is safe.
      await enqueuePendingDmHint(event.participantIds, {
        type: "dm:new_message",
        conversationId: event.conversationId,
        messageId: event.message.messageId,
        authorId: event.message.authorId,
        timeuuid: event.message.timeuuid,
      });
    }
    // Parallel direct-HTTP fanout to every realtime instance. Does not block
    // the caller's success path — pubsub + pending queue already guarantee
    // durability. This is purely a latency-cut for live delivery.
    void directHttpFanout(event);
  } catch (err) {
    logger.error({ err, eventType: event.type, conversationId: event.conversationId }, "redis publish failed");
    throw err;
  }
}
