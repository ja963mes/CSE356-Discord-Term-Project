/// <reference path="./types/express.d.ts" />
import express from "express";
import cookieParser from "cookie-parser";
import { z } from "zod";
import { cassandra, messagesCassandra } from "./cassandra";
import { requireAuth } from "./middleware/session";
import {
  assertChannelAccess,
  getChannelMessageIdForTimeuuid,
  getDmMessageIdForTimeuuid,
  getChannelState,
  getChannelStatesForCommunity,
  getDmParticipantReadStates,
  getDmStatesForUser,
  listDmParticipantIdsForEvent,
  markChannelRead,
  markDmRead,
} from "./repo";
import { redis } from "./redis";

const app = express();
app.use(express.json());
app.use(cookieParser());

const querySchema = z.object({
  communityId: z.string().uuid(),
});

const markReadSchema = z.object({
  messageId: z.string().uuid(),
  timeuuid: z.string().min(1),
});

/** `messageId` optional for forward compatibility; `timeuuid` is authoritative for resolving the row. */
const markDmReadSchema = z.object({
  timeuuid: z.string().min(1),
  messageId: z.string().uuid().optional(),
});

const conversationIdSchema = z.string().uuid();

app.get("/health", async (_req, res) => {
  try {
    await Promise.all([
      cassandra.execute("SELECT release_version FROM system.local"),
      messagesCassandra.execute("SELECT release_version FROM system.local"),
    ]);
    res.json({ status: "ok", service: "read-state-service", storage: "cassandra" });
  } catch (error) {
    console.error("[read-state] health check failed", error);
    res.status(503).json({ status: "degraded", service: "read-state-service", storage: "cassandra_unreachable" });
  }
});

app.get("/read-state/channels", requireAuth, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "communityId (UUID) is required" });
    return;
  }

  const channels = await getChannelStatesForCommunity(req.user!.internal_id, parsed.data.communityId);
  res.json({ channels });
});

app.get("/read-state/channels/:channelId", requireAuth, async (req, res) => {
  const channelIdResult = z.string().uuid().safeParse(req.params.channelId);
  if (!channelIdResult.success) {
    res.status(400).json({ error: "channelId (UUID) is required" });
    return;
  }

  const access = await assertChannelAccess(req.user!.internal_id, channelIdResult.data);
  if (!access.ok) {
    res.status(access.status).json({ error: access.status === 404 ? "Channel not found" : "Forbidden" });
    return;
  }

  const state = await getChannelState(req.user!.internal_id, channelIdResult.data);
  res.json({ state });
});

app.post("/read-state/channels/:channelId/read", requireAuth, async (req, res) => {
  const channelIdResult = z.string().uuid().safeParse(req.params.channelId);
  if (!channelIdResult.success) {
    res.status(400).json({ error: "channelId (UUID) is required" });
    return;
  }
  const body = markReadSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "messageId and timeuuid are required" });
    return;
  }

  const access = await assertChannelAccess(req.user!.internal_id, channelIdResult.data);
  if (!access.ok) {
    res.status(access.status).json({ error: access.status === 404 ? "Channel not found" : "Forbidden" });
    return;
  }

  // Trust client-provided messageId — the channel mark-read schema requires
  // it. Skipping the timeuuid→messageId Cassandra lookup is the whole point.
  // A bogus messageId only corrupts that user's own last_read; not worth the
  // per-mark-read read against messages_by_channel.
  try {
    await markChannelRead(req.user!.internal_id, channelIdResult.data, body.data.messageId, body.data.timeuuid);
  } catch {
    res.status(400).json({ error: "Invalid timeuuid" });
    return;
  }
  res.status(204).send();
});

app.get("/read-state/dms", requireAuth, async (req, res) => {
  const conversations = await getDmStatesForUser(req.user!.internal_id);
  res.json({ conversations });
});

app.get("/read-state/dms/:conversationId", requireAuth, async (req, res) => {
  const parsed = conversationIdSchema.safeParse(req.params.conversationId);
  if (!parsed.success) {
    res.status(400).json({ error: "conversationId (UUID) is required" });
    return;
  }

  try {
    const readState = await getDmParticipantReadStates(parsed.data, req.user!.internal_id);
    res.json({ readState });
  } catch {
    res.status(403).json({ error: "Forbidden" });
  }
});

app.post("/read-state/dms/:conversationId/read", requireAuth, async (req, res) => {
  const parsed = conversationIdSchema.safeParse(req.params.conversationId);
  if (!parsed.success) {
    res.status(400).json({ error: "conversationId (UUID) is required" });
    return;
  }
  const body = markDmReadSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "timeuuid is required" });
    return;
  }

  // Fast path: trust client-provided messageId, skip the timeuuid→messageId
  // Cassandra lookup against messages_by_conversation. Slow path (no messageId)
  // keeps the original lookup + channelId compatibility fallback for old
  // clients hitting this endpoint with a channelId by mistake.
  let messageId: string | null = body.data.messageId ?? null;
  if (!messageId) {
    try {
      messageId = await getDmMessageIdForTimeuuid(parsed.data, body.data.timeuuid);
    } catch {
      res.status(400).json({ error: "Invalid timeuuid" });
      return;
    }
    if (!messageId) {
      const channelAccess = await assertChannelAccess(req.user!.internal_id, parsed.data);
      if (!channelAccess.ok) {
        res.status(404).json({ error: "Message not found" });
        return;
      }

      let channelMessageId: string | null;
      try {
        channelMessageId = await getChannelMessageIdForTimeuuid(parsed.data, body.data.timeuuid);
      } catch {
        res.status(400).json({ error: "Invalid timeuuid" });
        return;
      }

      if (!channelMessageId) {
        res.status(404).json({ error: "Message not found" });
        return;
      }

      try {
        await markChannelRead(req.user!.internal_id, parsed.data, channelMessageId, body.data.timeuuid);
      } catch {
        res.status(400).json({ error: "Invalid timeuuid" });
        return;
      }

      res.status(204).send();
      return;
    }
  }

  try {
    await markDmRead(req.user!.internal_id, parsed.data, body.data.timeuuid, messageId);
  } catch {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const participantIds = await listDmParticipantIdsForEvent(parsed.data);
  const USER_FEED_SHARD_COUNT = 20;
  const event = {
    type: "dm:read-state:update",
    conversationId: parsed.data,
    participantIds,
    userId: req.user!.internal_id,
    messageId,
    timeuuid: body.data.timeuuid,
  };
  const pipeline = redis.pipeline();
  for (const participantId of participantIds) {
    const shard = parseInt(participantId.replace(/-/g, "").substring(0, 8), 16) % USER_FEED_SHARD_COUNT;
    pipeline.publish(`dm:userfeed:${shard}`, JSON.stringify({ targetUserId: participantId, event }));
  }
  await pipeline.exec();

  res.status(204).send();
});

export { app };
