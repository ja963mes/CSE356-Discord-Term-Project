import { redis } from "./redis";
import { logger } from "./logger";

const CHANNEL = "community:events";

export type CommunityEvent =
  | {
      type: "community:member:join";
      communityId: string;
      userId: string;
      username: string;
      displayName: string;
      role: string;
      joinedAt: string;
    }
  | {
      type: "community:member:leave";
      communityId: string;
      userId: string;
    }
  | {
      type: "community:channel:create";
      communityId: string;
      channel: {
        id: string;
        name: string;
        type: string;
        position: number;
        is_private: boolean;
      };
    }
  | {
      type: "community:channel:delete";
      communityId: string;
      channelId: string;
    }
  | {
      type: "community:channel:member:add";
      communityId: string;
      channelId: string;
      /** User who gained channel access (show channel in their sidebar). */
      userId: string;
      channel: {
        id: string;
        name: string;
        type: string;
        position: number;
        is_private: boolean;
      };
    }
  | {
      type: "community:channel:member:remove";
      communityId: string;
      channelId: string;
      /** User who lost channel access. */
      userId: string;
    }
  | {
      type: "community:directory:upsert";
      communityId: string;
      name: string;
      created_at: string;
    }
  | {
      type: "community:directory:delete";
      communityId: string;
    };

export async function publishCommunityEvent(event: CommunityEvent): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    logger.error({ err, eventType: event.type }, "community event publish failed");
  }
}
