/// <reference path="./types/express.d.ts" />

import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { types } from "cassandra-driver";
import { z } from "zod";
import { requireAuth } from "./middleware/session";
import { presignUpload } from "./minio";
import { cassandra } from "./cassandra";
import { httpLogger, logRouteError, logger } from "./logger";
import { metricsHandler } from "./metrics";
import {
  createConversation,
  createMessage,
  deleteMessage,
  DmError,
  editMessage,
  inviteParticipant,
  leaveConversation,
  listConversations,
  listMessages,
} from "./dm/service";

export const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(httpLogger);

const MAX_ATTACHMENTS = 4;
const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const createConversationSchema = z.object({
  type: z.enum(["one_to_one", "group"]),
  participantIds: z.array(z.string().uuid()).default([]),
  name: z.string().trim().max(120).optional(),
});

const inviteSchema = z.object({
  userId: z.string().uuid(),
});

const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  attachmentKeys: z.array(z.string()).max(MAX_ATTACHMENTS).default([]),
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

const presignSchema = z.object({
  files: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
      })
    )
    .min(1)
    .max(MAX_ATTACHMENTS),
});

function parseTimeuuid(raw: unknown, res: Response): string | null {
  try {
    return types.TimeUuid.fromString(String(raw)).toString();
  } catch {
    res.status(400).json({ error: "invalid timeuuid" });
    return null;
  }
}

app.get("/health", async (_req, res) => {
  try {
    await cassandra.execute("SELECT release_version FROM system.local");
    res.json({ status: "ok", service: "dms-service", storage: "cassandra" });
  } catch (err) {
    logRouteError("health check cassandra ping failed", err);
    res.status(503).json({ status: "degraded", service: "dms-service", storage: "cassandra_unreachable" });
  }
});

app.get("/metrics", (req, res, next) => {
  void metricsHandler(req, res).catch(next);
});

app.post("/attachments/presign", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { files } = presignSchema.parse(req.body);
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
  } catch (err) {
    next(err);
  }
});

app.get("/dms", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversations = await listConversations(req.user.internal_id);
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

app.post("/dms", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createConversationSchema.parse(req.body);
    const conversation = await createConversation({
      requesterId: req.user.internal_id,
      conversationType: body.type,
      participantIds: body.participantIds,
      name: body.name,
    });
    res.status(201).json({ conversation });
  } catch (err) {
    next(err);
  }
});

app.post("/dms/:id/participants", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const { userId } = inviteSchema.parse(req.body);
    await inviteParticipant(conversationId, req.user.internal_id, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

app.delete("/dms/:id/participants/me", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const result = await leaveConversation(conversationId, req.user.internal_id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/dms/:id/messages", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const body = createMessageSchema.parse(req.body);
    logger.info({
      conversationId,
      authorId: req.user.internal_id,
      receivedAt: new Date().toISOString(),
    }, "dm POST received");
    const message = await createMessage({
      conversationId,
      authorId: req.user.internal_id,
      content: body.content,
      attachmentKeys: body.attachmentKeys,
    });
    logger.info({
      conversationId,
      messageId: message.messageId,
      authorId: message.authorId,
      createdAt: message.createdAt,
      timeuuid: message.timeuuid,
    }, "dm POST responded 201");
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

app.get("/dms/:id/messages", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const { limit, before } = listMessagesSchema.parse(req.query);
    const result = await listMessages({
      conversationId,
      userId: req.user.internal_id,
      limit,
      before,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.patch("/dms/:id/messages/:timeuuid", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const timeuuid = parseTimeuuid(req.params.timeuuid, res);
    if (!timeuuid) return;
    const { content } = editMessageSchema.parse(req.body);
    const message = await editMessage({
      conversationId,
      authorId: req.user.internal_id,
      timeuuid,
      content,
    });
    res.json({ message });
  } catch (err) {
    next(err);
  }
});

app.delete("/dms/:id/messages/:timeuuid", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const timeuuid = parseTimeuuid(req.params.timeuuid, res);
    if (!timeuuid) return;
    await deleteMessage({
      conversationId,
      authorId: req.user.internal_id,
      timeuuid,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);

  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: err.issues });
    return;
  }
  if (err instanceof DmError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  logRouteError("unhandled route error", err, { reqId: req.id, method: req.method, path: req.path });
  res.status(500).json({ error: "Internal server error" });
});

// Silence TS unused-import warning for logger; ensures reference if all routes prune.
void logger;
