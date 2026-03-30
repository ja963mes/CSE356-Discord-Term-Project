import { types as cassandraTypes } from "cassandra-driver";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { and, eq, inArray } from "drizzle-orm";
import { cassandra } from "../db";
import { pg } from "../db/pg";
import { directConversations, dmParticipants } from "../db/pgSchema";
import { publishDmEvent } from "../events";

/** Derives a deterministic conversation ID from two user IDs. Always the same regardless of argument order. */
const oneToOneConversationId = (a: string, b: string): string =>
  uuidv5([a, b].sort().join(":"), uuidv5.URL);

export type ConversationType = "one_to_one" | "group";

export type ConversationRecord = {
  conversationId: string;
  conversationType: ConversationType;
  name: string | null;
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type MessageRecord = {
  messageId: string;
  conversationId: string;
  authorId: string;
  content: string;
  attachments: string[];
  /** ISO timestamp for display */
  createdAt: string;
  /** Cassandra clustering key — required for edit/delete */
  timeuuid: string;
  updatedAt: string | null;
  deleted: boolean;
};

const toUuid = (value: string): cassandraTypes.Uuid => cassandraTypes.Uuid.fromString(value);
const toTimeUuid = (value: string): cassandraTypes.TimeUuid => cassandraTypes.TimeUuid.fromString(value);

export class DmError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

const nowDate = () => new Date();

const mapMessage = (row: cassandraTypes.Row): MessageRecord => {
  const createdAtCol = row.get("created_at") as cassandraTypes.TimeUuid;
  const deleted = row.get("is_deleted") === true;
  return {
    messageId: row.get("message_id").toString(),
    conversationId: row.get("conversation_id").toString(),
    authorId: row.get("author_id").toString(),
    content: deleted ? "" : row.get("content"),
    attachments: deleted ? [] : JSON.parse(row.get("attachments") ?? "[]"),
    createdAt: createdAtCol.getDate().toISOString(),
    timeuuid: createdAtCol.toString(),
    updatedAt: (row.get("updated_at") as Date | null)?.toISOString() ?? null,
    deleted,
  };
};

// ─── Postgres helpers ────────────────────────────────────────────────────────

export const getConversation = async (conversationId: string): Promise<ConversationRecord | null> => {
  const rows = await pg.select().from(directConversations).where(eq(directConversations.id, conversationId));
  if (rows.length === 0) return null;
  const conv = rows[0];
  return {
    conversationId: conv.id,
    conversationType: conv.type as ConversationType,
    name: conv.name,
    participantIds: [],
    createdAt: conv.created_at.toISOString(),
    updatedAt: conv.updated_at.toISOString(),
  };
};

export const isParticipant = async (conversationId: string, userId: string): Promise<boolean> => {
  const rows = await pg
    .select({ user_id: dmParticipants.user_id })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversation_id, conversationId), eq(dmParticipants.user_id, userId)))
    .limit(1);
  return rows.length > 0;
};

const listParticipantIds = async (conversationId: string): Promise<string[]> => {
  const rows = await pg
    .select({ user_id: dmParticipants.user_id })
    .from(dmParticipants)
    .where(eq(dmParticipants.conversation_id, conversationId));
  return rows.map((r) => r.user_id);
};

const touchConversation = async (conversationId: string): Promise<void> => {
  await pg
    .update(directConversations)
    .set({ updated_at: nowDate() })
    .where(eq(directConversations.id, conversationId));
};

// ─── Public API ──────────────────────────────────────────────────────────────

export const listConversations = async (userId: string): Promise<ConversationRecord[]> => {
  // Get all conversation IDs for this user
  const userRows = await pg
    .select({ conversation_id: dmParticipants.conversation_id })
    .from(dmParticipants)
    .where(eq(dmParticipants.user_id, userId));

  if (userRows.length === 0) return [];

  const convIds = userRows.map((r) => r.conversation_id);

  // Fetch conversation metadata and all participants in parallel
  const [conversations, allParticipants] = await Promise.all([
    pg.select().from(directConversations).where(inArray(directConversations.id, convIds)),
    pg.select().from(dmParticipants).where(inArray(dmParticipants.conversation_id, convIds)),
  ]);

  // Group participants by conversation_id
  const participantMap = new Map<string, string[]>();
  for (const p of allParticipants) {
    const list = participantMap.get(p.conversation_id) ?? [];
    list.push(p.user_id);
    participantMap.set(p.conversation_id, list);
  }

  return conversations
    .map((conv) => ({
      conversationId: conv.id,
      conversationType: conv.type as ConversationType,
      name: conv.name,
      participantIds: participantMap.get(conv.id) ?? [],
      createdAt: conv.created_at.toISOString(),
      updatedAt: conv.updated_at.toISOString(),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const createConversation = async (params: {
  requesterId: string;
  conversationType: ConversationType;
  participantIds: string[];
  name?: string | null;
}): Promise<ConversationRecord> => {
  const participantSet = new Set([...params.participantIds, params.requesterId]);
  const participants = [...participantSet];

  if (params.conversationType === "one_to_one" && participants.length !== 2) {
    throw new DmError(400, "one_to_one conversations must have exactly 2 participants");
  }

  if (params.conversationType === "group" && participants.length < 2) {
    throw new DmError(400, "group conversations must have at least 2 participants");
  }

  const conversationId =
    params.conversationType === "one_to_one"
      ? oneToOneConversationId(participants[0], participants[1])
      : uuidv4();
  const createdAt = nowDate();
  const updatedAt = createdAt;
  const normalizedName = params.name?.trim() ? params.name.trim() : null;

  // INSERT ... ON CONFLICT DO NOTHING — idempotent for 1-to-1 deterministic IDs
  const inserted = await pg
    .insert(directConversations)
    .values({
      id: conversationId,
      type: params.conversationType,
      name: normalizedName,
      created_by: params.requesterId,
      created_at: createdAt,
      updated_at: updatedAt,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    // Conversation already existed — return it without re-publishing
    const existing = await getConversation(conversationId);
    if (existing) {
      existing.participantIds = await listParticipantIds(conversationId);
      return existing;
    }
  }

  // Insert participants
  await pg.insert(dmParticipants).values(
    participants.map((pid) => ({
      conversation_id: conversationId,
      user_id: pid,
      joined_at: createdAt,
    }))
  ).onConflictDoNothing();

  const record: ConversationRecord = {
    conversationId,
    conversationType: params.conversationType,
    name: normalizedName,
    participantIds: participants,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };

  await publishDmEvent({
    type: "dm:conversation:create",
    conversationId,
    participantIds: participants,
    conversation: {
      conversationId: record.conversationId,
      conversationType: record.conversationType,
      name: record.name,
      participantIds: participants,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  });

  return record;
};

export const inviteParticipant = async (
  conversationId: string,
  inviterId: string,
  participantId: string
): Promise<void> => {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new DmError(404, "Conversation not found");
  }
  if (conversation.conversationType !== "group") {
    throw new DmError(400, "Can only invite users to a group conversation");
  }
  if (!(await isParticipant(conversationId, inviterId))) {
    throw new DmError(403, "Only participants can invite users");
  }
  if (await isParticipant(conversationId, participantId)) {
    return;
  }

  await pg.insert(dmParticipants).values({
    conversation_id: conversationId,
    user_id: participantId,
    joined_at: nowDate(),
  });

  await touchConversation(conversationId);

  const participantIds = await listParticipantIds(conversationId);
  await publishDmEvent({
    type: "dm:participant:join",
    conversationId,
    participantIds,
    userId: participantId,
  });
};

const hardDeleteConversation = async (conversationId: string): Promise<void> => {
  // dmParticipants cascade deletes when directConversations row is deleted
  await pg.delete(directConversations).where(eq(directConversations.id, conversationId));
  // Delete messages from Cassandra
  await cassandra.execute(
    `DELETE FROM messages_by_conversation WHERE conversation_id = ?`,
    [toUuid(conversationId)],
    { prepare: true }
  );
};

export const leaveConversation = async (conversationId: string, userId: string): Promise<{ deleted: boolean }> => {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    throw new DmError(404, "Conversation not found");
  }
  if (!(await isParticipant(conversationId, userId))) {
    throw new DmError(403, "You are not a participant in this conversation");
  }

  await pg
    .delete(dmParticipants)
    .where(
      and(
        eq(dmParticipants.conversation_id, conversationId),
        eq(dmParticipants.user_id, userId)
      )
    );

  const remainingParticipants = await listParticipantIds(conversationId);
  const shouldDelete = remainingParticipants.length === 0 || conversation.conversationType === "one_to_one";

  await publishDmEvent({
    type: "dm:participant:leave",
    conversationId,
    participantIds: [...remainingParticipants, userId],
    userId,
    conversationDeleted: shouldDelete,
  });

  if (shouldDelete) {
    await hardDeleteConversation(conversationId);
    return { deleted: true };
  }

  await touchConversation(conversationId);
  return { deleted: false };
};

export const createMessage = async (params: {
  conversationId: string;
  authorId: string;
  content: string;
  attachments: string[];
}): Promise<MessageRecord> => {
  const conversation = await getConversation(params.conversationId);
  if (!conversation) {
    throw new DmError(404, "Conversation not found");
  }
  if (!(await isParticipant(params.conversationId, params.authorId))) {
    throw new DmError(403, "Only participants can post messages");
  }

  const messageId = uuidv4();
  const createdAt = cassandraTypes.TimeUuid.now();
  const content = params.content.trim();
  if (!content) {
    throw new DmError(400, "Message content cannot be empty");
  }
  if (params.attachments.length > 4) {
    throw new DmError(400, "A message can have at most 4 attachments");
  }

  await cassandra.execute(
    `INSERT INTO messages_by_conversation (conversation_id, created_at, message_id, author_id, content, attachments, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      toUuid(params.conversationId),
      createdAt,
      toUuid(messageId),
      toUuid(params.authorId),
      content,
      JSON.stringify(params.attachments),
      false,
    ],
    { prepare: true }
  );

  await touchConversation(params.conversationId);

  const messageRecord: MessageRecord = {
    messageId,
    conversationId: params.conversationId,
    authorId: params.authorId,
    content,
    attachments: params.attachments,
    createdAt: createdAt.getDate().toISOString(),
    timeuuid: createdAt.toString(),
    updatedAt: null,
    deleted: false,
  };

  const participantIds = await listParticipantIds(params.conversationId);
  await publishDmEvent({
    type: "dm:message:create",
    conversationId: params.conversationId,
    participantIds,
    message: {
      messageId,
      authorId: params.authorId,
      content,
      attachments: params.attachments,
      createdAt: messageRecord.createdAt,
      timeuuid: messageRecord.timeuuid,
    },
  });

  return messageRecord;
};

export const listMessages = async (params: {
  conversationId: string;
  userId: string;
  limit: number;
  before?: string;
}): Promise<{ messages: MessageRecord[]; nextCursor: string | null }> => {
  if (!(await isParticipant(params.conversationId, params.userId))) {
    throw new DmError(403, "Only participants can view conversation history");
  }

  const queryParts = [
    `SELECT conversation_id, created_at, message_id, author_id, content, attachments, updated_at, is_deleted`,
    `FROM messages_by_conversation`,
    `WHERE conversation_id = ?`,
  ];
  const values: unknown[] = [toUuid(params.conversationId)];

  if (params.before) {
    queryParts.push(`AND created_at < ?`);
    values.push(toTimeUuid(params.before));
  }
  queryParts.push(`LIMIT ?`);
  values.push(params.limit);

  const result = await cassandra.execute(queryParts.join(" "), values, { prepare: true });
  const messages = result.rows.map(mapMessage);
  const nextCursor =
    messages.length === params.limit
      ? result.rows[result.rows.length - 1].get("created_at").toString()
      : null;

  return { messages, nextCursor };
};

export const editMessage = async (params: {
  conversationId: string;
  messageId: string;
  authorId: string;
  timeuuid: string;
  content: string;
}): Promise<MessageRecord> => {
  if (!(await isParticipant(params.conversationId, params.authorId))) {
    throw new DmError(403, "Only participants can edit messages");
  }
  const result = await cassandra.execute(
    `SELECT author_id, attachments, is_deleted FROM messages_by_conversation
     WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [toUuid(params.conversationId), toTimeUuid(params.timeuuid), toUuid(params.messageId)],
    { prepare: true }
  );
  if (result.rowLength === 0) {
    throw new DmError(404, "Message not found");
  }
  if (result.first().get("is_deleted") === true) {
    throw new DmError(400, "This message was deleted");
  }
  if (result.first().get("author_id").toString() !== params.authorId) {
    throw new DmError(403, "Only the author can edit this message");
  }

  const updatedAt = nowDate();
  await cassandra.execute(
    `UPDATE messages_by_conversation SET content = ?, updated_at = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [params.content, updatedAt, toUuid(params.conversationId), toTimeUuid(params.timeuuid), toUuid(params.messageId)],
    { prepare: true }
  );

  const attachments = JSON.parse(result.first().get("attachments") ?? "[]");
  const messageRecord: MessageRecord = {
    messageId: params.messageId,
    conversationId: params.conversationId,
    authorId: params.authorId,
    content: params.content,
    attachments,
    createdAt: toTimeUuid(params.timeuuid).getDate().toISOString(),
    timeuuid: params.timeuuid,
    updatedAt: updatedAt.toISOString(),
    deleted: false,
  };

  const participantIds = await listParticipantIds(params.conversationId);
  await publishDmEvent({
    type: "dm:message:edit",
    conversationId: params.conversationId,
    participantIds,
    message: {
      messageId: params.messageId,
      authorId: params.authorId,
      content: params.content,
      createdAt: messageRecord.createdAt,
      updatedAt: messageRecord.updatedAt!,
      timeuuid: params.timeuuid,
    },
  });

  return messageRecord;
};

export const deleteMessage = async (params: {
  conversationId: string;
  messageId: string;
  authorId: string;
  timeuuid: string;
}): Promise<void> => {
  if (!(await isParticipant(params.conversationId, params.authorId))) {
    throw new DmError(403, "Only participants can delete messages");
  }

  const result = await cassandra.execute(
    `SELECT author_id, is_deleted FROM messages_by_conversation
     WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [toUuid(params.conversationId), toTimeUuid(params.timeuuid), toUuid(params.messageId)],
    { prepare: true }
  );

  if (result.rowLength === 0) {
    throw new DmError(404, "Message not found");
  }
  if (result.first().get("is_deleted") === true) {
    return;
  }
  if (result.first().get("author_id").toString() !== params.authorId) {
    throw new DmError(403, "Only the author can delete this message");
  }

  const deletedAt = nowDate();
  await cassandra.execute(
    `UPDATE messages_by_conversation SET is_deleted = true, content = '', attachments = ?, updated_at = ?
     WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [
      JSON.stringify([]),
      deletedAt,
      toUuid(params.conversationId),
      toTimeUuid(params.timeuuid),
      toUuid(params.messageId),
    ],
    { prepare: true }
  );

  const participantIds = await listParticipantIds(params.conversationId);
  await publishDmEvent({
    type: "dm:message:delete",
    conversationId: params.conversationId,
    participantIds,
    messageId: params.messageId,
    authorId: params.authorId,
  });
};
