import Redis from "ioredis";
import { env } from "./env";
import { kvCacheRedis } from "./redis";
import { indexMessage, updateContent, markDeleted, deleteByScope } from "./elasticsearch";
import { deleteCommunityDirectory, indexCommunityDirectory } from "./communitiesIndex";
import { logger } from "./logger";

/** Must match `services/communities/src/readCache.ts` — invalidates GET /search-communities Redis cache. */
const COMMUNITIES_DIRECTORY_EPOCH_KEY = "comm:e:dir";

async function bumpCommunitiesDirectorySearchEpoch(): Promise<void> {
  try {
    await kvCacheRedis.incr(COMMUNITIES_DIRECTORY_EPOCH_KEY);
  } catch (e) {
    logger.warn({ err: e }, "bump directory search epoch failed");
  }
}
import { db } from "./db";
import { users, channels } from "./db/schema";
import { eq } from "drizzle-orm";

// msgSub: pubsub instance — channel:events + dm:events.
// metaSub: meta pubsub instance — community:events.
const msgSub = new Redis(env.REDIS_URL, { enableReadyCheck: false });
const metaSub = new Redis(env.META_REDIS_URL, { enableReadyCheck: false });

for (const [name, client] of [["msg-sub", msgSub], ["meta-sub", metaSub]] as const) {
  client.on("connect", () => logger.info({ sub: name }, "redis subscriber connected"));
  client.on("reconnecting", () => logger.warn({ sub: name }, "redis subscriber reconnecting"));
  client.on("error", (err) => logger.error({ err, sub: name }, "redis subscriber error"));
}

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
  switch (data.type) {
    case "community:channel:delete":
      await deleteByScope(data.channelId);
      break;
    case "community:directory:upsert":
      await indexCommunityDirectory({
        community_id: data.communityId,
        name: data.name,
        created_at: data.created_at,
      });
      await bumpCommunitiesDirectorySearchEpoch();
      break;
    case "community:directory:delete":
      await deleteCommunityDirectory(data.communityId);
      await bumpCommunitiesDirectorySearchEpoch();
      break;
    default:
      break;
  }
}

function onMessage(channel: string, message: string): void {
  let data: any;
  try {
    data = JSON.parse(message);
  } catch {
    logger.warn({ channel }, "failed to parse pubsub event");
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
    logger.error({ err, channel, eventType: data?.type }, "error handling pubsub event");
  });
}

export async function startSubscriber(): Promise<void> {
  await msgSub.subscribe("channel:events", "dm:events");
  msgSub.on("message", onMessage);
  await metaSub.subscribe("community:events");
  metaSub.on("message", onMessage);
  logger.info(
    { msg: ["channel:events", "dm:events"], meta: ["community:events"] },
    "subscribed to pubsub channels"
  );
}
