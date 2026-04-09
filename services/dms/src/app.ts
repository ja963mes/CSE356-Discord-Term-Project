/// <reference path="./types/express.d.ts" />

import express from "express";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { z } from "zod";
import { requireAuth } from "./middleware/session";
import { presignUpload } from "./minio";
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
  markConversationRead,
} from "./dm/service";

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dms-service" });
});

app.post("/attachments/presign", requireAuth, async (req, res, next) => {
  try {
    const files: { filename: string; contentType: string }[] = Array.isArray(req.body?.files)
      ? req.body.files
      : [];

    if (files.length === 0 || files.length > 4) {
      res.status(400).json({ error: "Between 1 and 4 files required" });
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
  } catch (error) {
    next(error);
  }
});

const createConversationSchema = z.object({
  type: z.enum(["one_to_one", "group"]),
  participantIds: z.array(z.string().uuid()).default([]),
  name: z.string().trim().max(120).optional(),
});

const inviteSchema = z.object({
  userId: z.string().uuid(),
});

const ALLOWED_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const createMessageSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  attachmentKeys: z.array(z.string()).max(4).default([]),
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().optional(),
});

const editMessageSchema = z.object({
  content: z.string().min(1).max(4000),
  timeuuid: z.string().min(1),
});

const deleteMessageSchema = z.object({
  timeuuid: z.string().min(1),
});

const readStateSchema = z.object({
  timeuuid: z.string().min(1),
});

app.get("/dms", requireAuth, async (req, res, next) => {
  try {
    const conversations = await listConversations(req.user.internal_id);
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

app.post("/dms", requireAuth, async (req, res, next) => {
  try {
    const body = createConversationSchema.parse(req.body);
    const conversation = await createConversation({
      requesterId: req.user.internal_id,
      conversationType: body.type,
      participantIds: body.participantIds,
      name: body.name,
    });
    res.status(201).json({ conversation });
  } catch (error) {
    next(error);
  }
});

app.post("/dms/:id/participants", requireAuth, async (req, res, next) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const { userId } = inviteSchema.parse(req.body);
    await inviteParticipant(conversationId, req.user.internal_id, userId);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.delete("/dms/:id/participants/me", requireAuth, async (req, res, next) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const result = await leaveConversation(conversationId, req.user.internal_id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/dms/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const body = createMessageSchema.parse(req.body);
    const message = await createMessage({
      conversationId,
      authorId: req.user.internal_id,
      content: body.content,
      attachmentKeys: body.attachmentKeys,
    });
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

app.get("/dms/:id/messages", requireAuth, async (req, res, next) => {
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
  } catch (error) {
    next(error);
  }
});

app.post("/dms/:id/read-state", requireAuth, async (req, res, next) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const { timeuuid } = readStateSchema.parse(req.body);
    await markConversationRead(conversationId, req.user.internal_id, timeuuid);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.patch("/dms/:id/messages/:msgId", requireAuth, async (req, res, next) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const messageId = z.string().uuid().parse(req.params.msgId);
    const { content, timeuuid } = editMessageSchema.parse(req.body);
    const message = await editMessage({
      conversationId,
      messageId,
      authorId: req.user.internal_id,
      timeuuid,
      content,
    });
    res.json({ message });
  } catch (error) {
    next(error);
  }
});

app.delete("/dms/:id/messages/:msgId", requireAuth, async (req, res, next) => {
  try {
    const conversationId = z.string().uuid().parse(req.params.id);
    const messageId = z.string().uuid().parse(req.params.msgId);
    const { timeuuid } = deleteMessageSchema.parse(req.query);
    await deleteMessage({
      conversationId,
      messageId,
      authorId: req.user.internal_id,
      timeuuid,
    });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: error.issues });
    return;
  }

  if (error instanceof DmError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  console.error("[dms] unhandled error", error);
  res.status(500).json({ error: "Internal server error" });
});
