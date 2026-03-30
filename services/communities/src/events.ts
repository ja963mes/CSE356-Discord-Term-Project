import { redis } from "./redis";

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
    };

export async function publishCommunityEvent(event: CommunityEvent): Promise<void> {
  try {
    await redis.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    console.error("[communities] failed to publish event", event.type, err);
  }
}
