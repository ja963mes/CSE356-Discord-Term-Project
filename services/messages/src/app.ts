/// <reference path="./types/express.d.ts" />
import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { httpLogger, logRouteError, logger } from "./logger";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { requireAuth } from "./middleware/session";
import { channels, channelMembers, communityMembers, users } from "./db/schema";
import { cassandra, parseBeforeCursor } from "./cassandra";
import {
  insertChannelMessage,
  listChannelMessages,
  getChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
} from "./cassandraRepo";
import { publishChannelEvent } from "./events";
import { presignUpload, keyToUrl } from "./minio";
import { randomUUID } from "crypto";
import { types } from "cassandra-driver";

export const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(httpLogger);

const MAX_CONTENT = 4000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ATTACHMENTS = 4;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function timeuuidToDate(t: types.TimeUuid): string {
  return new Date(t.getDate().getTime()).toISOString();
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

app.get("/health", async (req, res) => {
  try {
    await cassandra.execute("SELECT release_version FROM system.local");
    res.json({ status: "ok", service: "messages-service", storage: "cassandra" });
  } catch (e) {
    logRouteError("GET /health cassandra ping failed", e, { reqId: req.id });
    res.status(503).json({ status: "degraded", service: "messages-service", storage: "cassandra_unreachable" });
  }
});

app.post("/attachments/presign", requireAuth, async (req: Request, res: Response) => {
  const files: { filename: string; contentType: string }[] = Array.isArray(req.body?.files)
    ? req.body.files
    : [];

  if (files.length === 0 || files.length > MAX_ATTACHMENTS) {
    res.status(400).json({ error: `Between 1 and ${MAX_ATTACHMENTS} files required` });
    return;
  }

  for (const f of files) {
    if (!ALLOWED_CONTENT_TYPES.has(f.contentType)) {
      res.status(400).json({ error: `Unsupported content type: ${f.contentType}. Allowed: jpeg, png, gif, webp` });
      return;
    }
  }

  const results = await Promise.all(
    files.map(async ({ filename, contentType }) => {
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `${randomUUID()}-${safeName}`;
      const uploadUrl = await presignUpload(key, contentType);
      return { key, uploadUrl };
    })
  );

  res.json({ files: results });
});

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
  const messages = [...rows].reverse().map((r) => ({
    id: r.messageId,
    timeuuid: r.createdAt.toString(),
    authorId: r.authorId,
    author: r.authorUsername,
    content: r.content,
    createdAt: timeuuidToDate(r.createdAt),
    editedAt: r.editedAt ? r.editedAt.toISOString() : null,
    attachmentKeys: r.attachmentKeys,
    attachmentUrls: r.attachmentKeys.map(keyToUrl),
  }));

  res.json({ channelId, messages });
});

app.post("/messages", requireAuth, async (req: Request, res: Response) => {
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId.trim() : "";
  const contentRaw = typeof req.body?.content === "string" ? req.body.content : "";
  const content = contentRaw.trim();
  const attachmentKeys: string[] = Array.isArray(req.body?.attachmentKeys)
    ? (req.body.attachmentKeys as unknown[]).filter((k): k is string => typeof k === "string").slice(0, 4)
    : [];

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
  logger.info({ userId, channelId, receivedAt: new Date().toISOString() }, "channel message POST received");
  const access = await assertChannelAccess(userId, channelId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.status === 404 ? "Channel not found" : "Forbidden" });
    return;
  }

  const [author] = await db.select({ username: users.username }).from(users).where(eq(users.internal_id, userId)).limit(1);
  const authorUsername = author?.username ?? "unknown";

  const { messageId, createdAt } = await insertChannelMessage({
    channelId,
    communityId: access.channel.community_id,
    authorId: userId,
    authorUsername,
    content,
    attachmentKeys,
  });

  logger.info({ userId, channelId, messageId, timeuuid: createdAt.toString(), storedAt: new Date().toISOString() }, "channel message stored");

  const message = {
    id: messageId,
    messageId,
    timeuuid: createdAt.toString(),
    authorId: userId,
    author: authorUsername,
    authorUsername,
    content,
    attachmentKeys,
    attachmentUrls: attachmentKeys.map(keyToUrl),
    createdAt: timeuuidToDate(createdAt),
    editedAt: null,
  };

  await publishChannelEvent({
    type: "channel:message:create",
    channelId,
    communityId: access.channel.community_id,
    message,
  });

  logger.info({ userId, channelId, messageId, timeuuid: createdAt.toString(), publishedAt: new Date().toISOString(), type: "channel:message:create" }, "channel event published");

  res.status(201).json({ message });
});

app.patch("/messages/:channelId/:timeuuid", requireAuth, async (req: Request, res: Response) => {
  const channelId = String(req.params.channelId);
  const timeuuidParam = String(req.params.timeuuid);
  const contentRaw = typeof req.body?.content === "string" ? req.body.content : "";
  const content = contentRaw.trim();

  if (!isUuid(channelId)) {
    res.status(400).json({ error: "invalid channelId" });
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

  let createdAt: types.TimeUuid;
  try {
    createdAt = types.TimeUuid.fromString(timeuuidParam);
  } catch {
    res.status(400).json({ error: "invalid timeuuid" });
    return;
  }

  const existing = await getChannelMessage(channelId, createdAt);
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (existing.authorId !== userId) {
    res.status(403).json({ error: "Cannot edit another user's message" });
    return;
  }

  await editChannelMessage({ channelId, createdAt, messageId: existing.messageId, newContent: content });

  const editedAt = new Date().toISOString();
  await publishChannelEvent({
    type: "channel:message:edit",
    channelId,
    communityId: access.channel.community_id,
    message: {
      messageId: existing.messageId,
      timeuuid: timeuuidParam,
      authorId: userId,
      content,
      editedAt,
    },
  });

  res.json({ messageId: existing.messageId, timeuuid: timeuuidParam, content, editedAt });
});

app.delete("/messages/:channelId/:timeuuid", requireAuth, async (req: Request, res: Response) => {
  const channelId = String(req.params.channelId);
  const timeuuidParam = String(req.params.timeuuid);

  if (!isUuid(channelId)) {
    res.status(400).json({ error: "invalid channelId" });
    return;
  }

  const userId = req.user!.internal_id;
  const access = await assertChannelAccess(userId, channelId);
  if (!access.ok) {
    res.status(access.status).json({ error: access.status === 404 ? "Channel not found" : "Forbidden" });
    return;
  }

  let createdAt: types.TimeUuid;
  try {
    createdAt = types.TimeUuid.fromString(timeuuidParam);
  } catch {
    res.status(400).json({ error: "invalid timeuuid" });
    return;
  }

  const existing = await getChannelMessage(channelId, createdAt);
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  if (existing.authorId !== userId) {
    res.status(403).json({ error: "Cannot delete another user's message" });
    return;
  }

  await deleteChannelMessage({ channelId, createdAt, messageId: existing.messageId });

  await publishChannelEvent({
    type: "channel:message:delete",
    channelId,
    communityId: access.channel.community_id,
    messageId: existing.messageId,
    id: existing.messageId,
    timeuuid: timeuuidParam,
    authorId: userId,
    message: {
      id: existing.messageId,
      messageId: existing.messageId,
      timeuuid: timeuuidParam,
      authorId: userId,
    },
  });

  res.status(204).send();
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  logRouteError("Unhandled route error", err, {
    reqId: req.id,
    method: req.method,
    path: req.path,
  });
  res.status(500).json({ error: "Internal server error" });
});
