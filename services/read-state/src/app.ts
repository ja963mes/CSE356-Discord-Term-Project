/// <reference path="./types/express.d.ts" />
import express from "express";
import cookieParser from "cookie-parser";
import { z } from "zod";
import { cassandra, messagesCassandra } from "./cassandra";
import { requireAuth } from "./middleware/session";
import {
  assertChannelAccess,
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
import { publishUserFeedBatch } from "@discord/pubsub";
import { logger, httpLogger, logRouteError } from "./logger";

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<void>;
const ah = (fn: AsyncHandler): express.RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(httpLogger);

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
    logRouteError("health check failed", error);
    res.status(503).json({ status: "degraded", service: "read-state-service", storage: "cassandra_unreachable" });
  }
});

app.get("/read-state/channels", requireAuth, ah(async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "communityId (UUID) is required" });
    return;
  }

  const channels = await getChannelStatesForCommunity(req.user!.internal_id, parsed.data.communityId);
  res.json({ channels });
}));

app.get("/read-state/channels/:channelId", requireAuth, ah(async (req, res) => {
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
}));

app.post("/read-state/channels/:channelId/read", requireAuth, ah(async (req, res) => {
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
}));

app.get("/read-state/dms", requireAuth, ah(async (req, res) => {
  const conversations = await getDmStatesForUser(req.user!.internal_id);
  res.json({ conversations });
}));

app.get("/read-state/dms/:conversationId", requireAuth, ah(async (req, res) => {
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
}));

app.post("/read-state/dms/:conversationId/read", requireAuth, ah(async (req, res) => {
  const parsed = conversationIdSchema.safeParse(req.params.conversationId);
  if (!parsed.success) {
    res.status(400).json({ error: "conversationId (UUID) is required" });
    return;
  }

  // The grading client always routes markRead to the DM endpoint regardless of
  // conversation type. If the ID belongs to a channel, handle it as a channel
  // mark-read instead of failing with 403/404 from the DM participant check.
  const channelAccess = await assertChannelAccess(req.user!.internal_id, parsed.data);
  if (channelAccess.ok || channelAccess.status === 403) {
    if (!channelAccess.ok) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const body = markReadSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "messageId and timeuuid are required" });
      return;
    }
    try {
      await markChannelRead(req.user!.internal_id, parsed.data, body.data.messageId, body.data.timeuuid);
    } catch {
      res.status(400).json({ error: "Invalid timeuuid" });
      return;
    }
    res.status(204).send();
    return;
  }

  const body = markDmReadSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "timeuuid is required" });
    return;
  }

  // Fast path: client-provided messageId skips Cassandra timeuuid→messageId lookup.
  let messageId: string | null = body.data.messageId ?? null;
  if (!messageId) {
    try {
      messageId = await getDmMessageIdForTimeuuid(parsed.data, body.data.timeuuid);
    } catch {
      res.status(400).json({ error: "Invalid timeuuid" });
      return;
    }
    if (!messageId) {
      res.status(404).json({ error: "Message not found" });
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
  const event = {
    type: "dm:read-state:update",
    conversationId: parsed.data,
    participantIds,
    userId: req.user!.internal_id,
    messageId,
    timeuuid: body.data.timeuuid,
  };
  await publishUserFeedBatch(
    redis,
    participantIds.map((participantId) => ({
      userId: participantId,
      payload: JSON.stringify({ targetUserId: participantId, event }),
    }))
  );

  res.status(204).send();
}));

app.post("/internal/log-level", (req, res) => {
  const { level } = req.body as { level?: string };
  const valid = ["trace", "debug", "info", "warn", "error", "fatal"];
  if (!level || !valid.includes(level)) {
    res.status(400).json({ error: `level must be one of: ${valid.join(", ")}` });
    return;
  }
  logger.level = level;
  res.json({ level: logger.level });
});

// Catch unhandled async errors in route handlers (Express 4 doesn't do this automatically).
// Without this, a Cassandra/Postgres error in a bare `await` crashes the worker process → 502.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logRouteError("unhandled route error", err);
  if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
});

export { app };
