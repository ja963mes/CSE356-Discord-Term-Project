import Redis from "ioredis";
import { env } from "./env";
import { indexMessage, updateContent, markDeleted, deleteByScope } from "./elasticsearch";
import { db } from "./db";
import { users, channels } from "./db/schema";
import { eq } from "drizzle-orm";

const sub = new Redis(env.REDIS_URL, { enableReadyCheck: false});

sub.on("connect", () => console.log("[search] Redis subscriber connected"));
sub.on("error", (err) => console.error("[search] Redis subscriber error:", err));

// Simple in-memory cache for username lookups
const usernameCache = new Map<string, { username: string; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function lookupUsername(authorId: string): Promise<string> {
  const cached = usernameCache.get(authorId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.username;

  const [row] = await db
    .select({ username: users.username })
    .from(users)
    .where(eq(users.internal_id, authorId))
    .limit(1);
  const username = row?.username ?? "unknown";
  usernameCache.set(authorId, { username, ts: Date.now() });
  return username;
}

// Simple in-memory cache for channel name lookups
const channelNameCache = new Map<string, { name: string; ts: number }>();

async function lookupChannelName(channelId: string): Promise<string> {
  const cached = channelNameCache.get(channelId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.name;

  const [row] = await db
    .select({ name: channels.name })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  const name = row?.name ?? "unknown";
  channelNameCache.set(channelId, { name, ts: Date.now() });
  return name;
}

async function handleChannelEvent(data: any): Promise<void> {
  switch (data.type) {
    case "channel:message:create": {
      const msg = data.message;
      const channelName = await lookupChannelName(data.channelId);
      await indexMessage({
        message_id: msg.messageId,
        scope_type: "channel",
        scope_id: data.channelId,
        community_id: data.communityId,
        channel_name: channelName,
        author_id: msg.authorId,
        author_username: msg.authorUsername,
        content: msg.content,
        created_at: msg.createdAt,
        is_deleted: false,
      });
      break;
    }
    case "channel:message:edit": {
      const msg = data.message;
      await updateContent(msg.messageId, msg.content, msg.editedAt);
      break;
    }
    case "channel:message:delete": {
      await markDeleted(data.messageId);
      break;
    }
  }
}

async function handleDmEvent(data: any): Promise<void> {
  switch (data.type) {
    case "dm:message:create": {
      const msg = data.message;
      const authorUsername = msg.authorUsername ?? await lookupUsername(msg.authorId);
      await indexMessage({
        message_id: msg.messageId,
        scope_type: "dm",
        scope_id: data.conversationId,
        community_id: null,
        channel_name: null,
        author_id: msg.authorId,
        author_username: authorUsername,
        content: msg.content,
        created_at: msg.createdAt,
        is_deleted: false,
      });
      break;
    }
    case "dm:message:edit": {
      const msg = data.message;
      const authorUsername = msg.authorUsername ?? await lookupUsername(msg.authorId);
      await indexMessage({
        message_id: msg.messageId,
        scope_type: "dm",
        scope_id: data.conversationId,
        community_id: null,
        channel_name: null,
        author_id: msg.authorId,
        author_username: authorUsername,
        content: msg.content,
        created_at: msg.createdAt,
        updated_at: msg.updatedAt,
        is_deleted: false,
      });
      break;
    }
    case "dm:message:delete": {
      await markDeleted(data.messageId);
      break;
    }
    case "dm:participant:leave": {
      if (data.conversationDeleted) {
        await deleteByScope(data.conversationId);
      }
      break;
    }
  }
}

async function handleCommunityEvent(data: any): Promise<void> {
  if (data.type === "community:channel:delete") {
    await deleteByScope(data.channelId);
  }
}

function onMessage(channel: string, message: string): void {
  let data: any;
  try {
    data = JSON.parse(message);
  } catch {
    console.error("[search] Failed to parse event from", channel);
    return;
  }

  let promise: Promise<void>;
  switch (channel) {
    case "channel:events":
      promise = handleChannelEvent(data);
      break;
    case "dm:events":
      promise = handleDmEvent(data);
      break;
    case "community:events":
      promise = handleCommunityEvent(data);
      break;
    default:
      return;
  }

  promise.catch((err) => {
    console.error("[search] Error handling event", data?.type, err);
  });
}

export async function startSubscriber(): Promise<void> {
  await sub.subscribe("channel:events", "dm:events", "community:events");
  sub.on("message", onMessage);
  console.log("[search] Subscribed to channel:events, dm:events, community:events");
}
