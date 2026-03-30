/// <reference path="./types/express.d.ts" />

import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import { z } from "zod";
import { env } from "./env";
import { initializeCassandra } from "./db";
import { requireAuth } from "./middleware/session";
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


dotenv.config();
  
const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dms-service" });
});

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
  attachments: z.array(z.string().url()).max(4).default([]),
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
      attachments: body.attachments,
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

const port = Number(env.DMS_PORT);
initializeCassandra()
  .then(() => {
    app.listen(port, () => {
      console.log(`DMS service running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("[dms] failed to initialize", error);
    process.exit(1);
  });

