/// <reference path="./types/express.d.ts" />
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { eq, and } from "drizzle-orm";
import { db } from "./db";
import { requireAuth } from "./middleware/session";
import { channels, channelMembers, communityMembers, readState, users } from "./db/schema";
import { cassandra, parseBeforeCursor } from "./cassandra";
import {
  insertChannelMessage,
  listChannelMessages,
  getChannelMessage,
  editChannelMessage,
  deleteChannelMessage,
  getLatestChannelMessageTimeuuid,
} from "./cassandraRepo";
import { publishChannelEvent } from "./events";
import { presignUpload, keyToUrl } from "./minio";
import { randomUUID } from "crypto";
import { types } from "cassandra-driver";

export const app = express();
app.use(express.json());
app.use(cookieParser());

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

function compareTimeuuids(a: string, b: string): number {
  return types.TimeUuid.fromString(a).getBuffer().compare(types.TimeUuid.fromString(b).getBuffer());
}

async function upsertChannelReadState(userId: string, channelId: string, timeuuid: string): Promise<void> {
  const inserted = await db.insert(readState).values({
      user_id: userId,
      context_type: "channel",
      context_id: channelId,
      last_read_timeuuid: timeuuid,
      updated_at: new Date(),
    })
    .onConflictDoNothing()
    .returning({ last_read_timeuuid: readState.last_read_timeuuid });

  if (inserted.length > 0) {
    return;
  }

  const [existing] = await db
    .select({ last_read_timeuuid: readState.last_read_timeuuid })
    .from(readState)
    .where(and(
      eq(readState.user_id, userId),
      eq(readState.context_type, "channel"),
      eq(readState.context_id, channelId),
    ))
    .limit(1);

  if (!existing || compareTimeuuids(timeuuid, existing.last_read_timeuuid) <= 0) {
    return;
  }

  await db.update(readState)
    .set({ last_read_timeuuid: timeuuid, updated_at: new Date() })
    .where(and(
      eq(readState.user_id, userId),
      eq(readState.context_type, "channel"),
      eq(readState.context_id, channelId),
    ));
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

app.get("/health", async (_req, res) => {
  try {
    await cassandra.execute("SELECT release_version FROM system.local");
    res.json({ status: "ok", service: "messages-service", storage: "cassandra" });
  } catch (e) {
    console.error(e);
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

app.get("/messages/read-state", requireAuth, async (req: Request, res: Response) => {
  const communityId = String(req.query.communityId ?? "");
  if (!communityId || !isUuid(communityId)) {
    res.status(400).json({ error: "communityId (UUID) is required" });
    return;
  }

  const userId = req.user!.internal_id;
  const member = await db
    .select({ user_id: communityMembers.user_id })
    .from(communityMembers)
    .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
    .limit(1);
  if (member.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const allowedChannels = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channel_id, channels.id))
    .where(and(eq(channels.community_id, communityId), eq(channelMembers.user_id, userId)));

  const summaries = await Promise.all(allowedChannels.map(async ({ id }) => {
    const [state] = await db
      .select({ last_read_timeuuid: readState.last_read_timeuuid })
      .from(readState)
      .where(and(
        eq(readState.user_id, userId),
        eq(readState.context_type, "channel"),
        eq(readState.context_id, id),
      ))
      .limit(1);

    const latestTimeuuid = await getLatestChannelMessageTimeuuid(id);
    return {
      channelId: id,
      lastReadTimeuuid: state?.last_read_timeuuid ?? null,
      latestTimeuuid,
      hasUnread: latestTimeuuid != null && (!state || compareTimeuuids(latestTimeuuid, state.last_read_timeuuid) > 0),
    };
  }));

  res.json({ channels: summaries });
});

app.post("/messages/read-state", requireAuth, async (req: Request, res: Response) => {
  const channelId = typeof req.body?.channelId === "string" ? req.body.channelId.trim() : "";
  const timeuuid = typeof req.body?.timeuuid === "string" ? req.body.timeuuid.trim() : "";

  if (!channelId || !isUuid(channelId)) {
    res.status(400).json({ error: "channelId (UUID) is required" });
    return;
  }
  if (!timeuuid) {
    res.status(400).json({ error: "timeuuid is required" });
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
    createdAt = types.TimeUuid.fromString(timeuuid);
  } catch {
    res.status(400).json({ error: "invalid timeuuid" });
    return;
  }

  const existing = await getChannelMessage(channelId, createdAt);
  if (!existing) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  await upsertChannelReadState(userId, channelId, timeuuid);
  res.status(204).send();
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
    timeuuid: timeuuidParam,
    authorId: userId,
  });

  res.status(204).send();
});
