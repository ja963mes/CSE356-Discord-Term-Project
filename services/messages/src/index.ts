/// <reference path="./types/express.d.ts" />
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { env } from "./env";
import { requireAuth } from "./middleware/session";
import { channels, channelMembers, communityMembers, users } from "./db/schema";
import { cassandra, initializeCassandra, parseBeforeCursor } from "./cassandra";
import { insertChannelMessage, listChannelMessages } from "./cassandraRepo";
import { publishChannelEvent } from "./events";

const app = express();
app.use(express.json());
app.use(cookieParser());

const MAX_CONTENT = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

async function assertChannelAccess(
  userId: string,
  channelId: string
): Promise<
  | { ok: true; channel: { id: string; community_id: string } }
  | { ok: false; status: 404 | 403 }
> {
  const [ch] = await db
    .select({ id: channels.id, community_id: channels.community_id })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!ch) return { ok: false, status: 404 };

  const [gm] = await db
    .select()
    .from(communityMembers)
    .where(and(eq(communityMembers.community_id, ch.community_id), eq(communityMembers.user_id, userId)))
    .limit(1);
  if (!gm) return { ok: false, status: 403 };

  const [cm] = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId)))
    .limit(1);
  if (!cm) return { ok: false, status: 403 };

  return { ok: true, channel: { id: ch.id, community_id: ch.community_id } };
}

function setRoutingHeaders(res: Response, channelId: string, communityId: string): void {
  res.setHeader("X-Partition-Key", channelId);
  res.setHeader("X-Shard-Key-Community", communityId);
  res.setHeader("X-Storage-Keyspace", env.MESSAGES_CASSANDRA_KEYSPACE);
  res.setHeader(
    "X-Cassandra-Replication",
    `${env.CASSANDRA_TOPOLOGY}:rf=${env.CASSANDRA_REPLICATION_FACTOR};dc=${env.CASSANDRA_LOCAL_DATACENTER}`
  );
}

app.get("/health", async (_req, res) => {
  try {
    await cassandra.execute("SELECT release_version FROM system.local");
    res.json({ status: "ok", service: "messages-service", storage: "cassandra" });
  } catch (e) {
    console.error(e);
    res.status(503).json({ status: "degraded", service: "messages-service", storage: "cassandra_unreachable" });
  }
});

/** List messages for a channel (Cassandra; oldest → newest in JSON). */
app.get("/messages", requireAuth, async (req: Request, res: Response) => {
  const channelId = String(req.query.channelId ?? "");
  if (!channelId || !isUuid(channelId)) {
    res.status(400).json({ error: "channelId (UUID) is required" });
    return;
  }

  const userId = req.user!.internal_id;
  const access = await assertChannelAccess(userId, channelId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.status === 404 ? "Channel not found" : "Forbidden" });
    return;
  }

  const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT, 1), MAX_LIMIT);
  const beforeRaw = req.query.before != null ? String(req.query.before) : "";
  const beforeTuuid = beforeRaw ? parseBeforeCursor(beforeRaw) : null;

  const rows = await listChannelMessages(channelId, limit, beforeTuuid);
  const chronological = [...rows].reverse();
  const messages = chronological.map((r) => ({
    id: r.messageId,
    author: r.authorUsername,
    content: r.content,
    ts: r.createdAt.getDate().toISOString(),
  }));

  setRoutingHeaders(res, channelId, access.channel.community_id);
  res.json({ channelId, messages });
});

/** Post a message to a channel. */
app.post("/messages", requireAuth, async (req: Request, res: Response) => {
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId.trim() : "";
  const contentRaw = typeof req.body?.content === "string" ? req.body.content : "";
  const content = contentRaw.trim();

  if (!channelId || !isUuid(channelId)) {
    res.status(400).json({ error: "channelId (UUID) is required" });
    return;
  }
  if (!content) {
    res.status(400).json({ error: "content is required" });
    return;
  }
  if (content.length > MAX_CONTENT) {
    res.status(400).json({ error: `content must be at most ${MAX_CONTENT} characters` });
    return;
  }

  const userId = req.user!.internal_id;
  const access = await assertChannelAccess(userId, channelId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.status === 404 ? "Channel not found" : "Forbidden" });
    return;
  }

  const [author] = await db.select({ username: users.username }).from(users).where(eq(users.internal_id, userId)).limit(1);

  const { messageId, createdAt } = await insertChannelMessage({
    channelId,
    communityId: access.channel.community_id,
    authorId: userId,
    authorUsername: author?.username ?? "unknown",
    content,
  });

  const ts = createdAt.getDate().toISOString();

  void publishChannelEvent({
    type: "channel:message:create",
    channelId,
    communityId: access.channel.community_id,
    message: {
      messageId,
      authorId: userId,
      authorUsername: author?.username ?? "unknown",
      content,
      createdAt: ts,
    },
  });

  setRoutingHeaders(res, channelId, access.channel.community_id);
  res.status(201).json({
    message: {
      id: messageId,
      author: author?.username ?? "unknown",
      content,
      ts,
    },
  });
});

const port = Number(env.MESSAGES_PORT);

void (async () => {
  await initializeCassandra();
  app.listen(port, () => {
    console.log(`Messages service running on port ${port} (Cassandra keyspace=${env.MESSAGES_CASSANDRA_KEYSPACE})`);
  });
})();
