import { types as cassandraTypes } from "cassandra-driver";
import { v4 as uuidv4 } from "uuid";
import { cassandra } from "../db";
import { publishDmEvent } from "../events";

export type ConversationType = "one_to_one" | "group";

export type ConversationRecord = {
  conversationId: string;
  conversationType: ConversationType;
  name: string | null;
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

const mapConversation = (row: cassandraTypes.Row): ConversationRecord => ({
  conversationId: row.get("conversation_id").toString(),
  conversationType: row.get("conversation_type") as ConversationType,
  name: row.get("name"),
  createdAt: (row.get("created_at") as Date).toISOString(),
  updatedAt: (row.get("updated_at") as Date).toISOString(),
});

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

export const editMessage = async (params: {
  conversationId: string;
  messageId: string;
  authorId: string;
  timeuuid: string;
  content: string;
}): Promise<MessageRecord> => {
  if(!(await isParticipant(params.conversationId, params.authorId))) {
    throw new DmError(403, "Only participants can edit messages");
  }
    const result = await cassandra.execute(
    `SELECT author_id, attachments, is_deleted FROM messages_by_conversation
     WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [toUuid(params.conversationId), toTimeUuid(params.timeuuid), toUuid(params.messageId)],
    { prepare: true }
  );
  if(result.rowLength === 0){
    throw new DmError(404, "Message not found");
  }
  if (result.first().get("is_deleted") === true) {
    throw new DmError(400, "This message was deleted");
  }
  if(result.first().get("author_id").toString() !== params.authorId){
    throw new DmError(403, "Only the author can edit this message"); 
  }

  const updatedAt = nowDate();
  await cassandra.execute(
    `UPDATE messages_by_conversation SET content = ?, updated_at = ? WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [params.content, updatedAt, toUuid(params.conversationId), toTimeUuid(params.timeuuid), toUuid(params.messageId)],
    { prepare: true }
  );

  const attachments = JSON.parse(result.first().get("attachments") ?? "[]");

  const messageRecords: MessageRecord = {
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
      createdAt: messageRecords.createdAt,
      updatedAt: messageRecords.updatedAt!,
      timeuuid: params.timeuuid,
    },
  });

  return messageRecords;
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

export const listConversations = async (userId: string): Promise<ConversationRecord[]> => {
  const result = await cassandra.execute(
    `SELECT conversation_id, conversation_type, name, created_at, updated_at
     FROM conversations_by_user
     WHERE user_id = ?`,
    [toUuid(userId)],
    { prepare: true }
  );

  return result.rows.map(mapConversation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const getConversation = async (conversationId: string): Promise<ConversationRecord | null> => {
  const result = await cassandra.execute(
    `SELECT conversation_id, conversation_type, name, created_at, updated_at
     FROM conversations
     WHERE conversation_id = ?`,
    [toUuid(conversationId)],
    { prepare: true }
  );
  const row = result.first();
  return row ? mapConversation(row) : null;
};

export const isParticipant = async (conversationId: string, userId: string): Promise<boolean> => {
  const result = await cassandra.execute(
    `SELECT user_id FROM participants_by_conversation
     WHERE conversation_id = ? AND user_id = ?`,
    [toUuid(conversationId), toUuid(userId)],
    { prepare: true }
  );
  return result.rowLength > 0;
};

const listParticipantIds = async (conversationId: string): Promise<string[]> => {
  const result = await cassandra.execute(
    `SELECT user_id FROM participants_by_conversation WHERE conversation_id = ?`,
    [toUuid(conversationId)],
    { prepare: true }
  );
  return result.rows.map((row) => row.get("user_id").toString());
};

const upsertConversationUserIndex = async (
  userId: string,
  conversationId: string,
  conversationType: ConversationType,
  name: string | null,
  createdAt: Date,
  updatedAt: Date
): Promise<void> => {
  await cassandra.execute(
    `INSERT INTO conversations_by_user (user_id, conversation_id, conversation_type, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [toUuid(userId), toUuid(conversationId), conversationType, name, createdAt, updatedAt],
    { prepare: true }
  );
};

const touchConversation = async (conversationId: string): Promise<void> => {
  const updatedAt = nowDate();
  await cassandra.execute(
    `UPDATE conversations SET updated_at = ? WHERE conversation_id = ?`,
    [updatedAt, toUuid(conversationId)],
    { prepare: true }
  );

  const conversation = await getConversation(conversationId);
  if (!conversation) {
    return;
  }

  const participants = await listParticipantIds(conversationId);
  await Promise.all(
    participants.map((participantId) =>
      upsertConversationUserIndex(
        participantId,
        conversationId,
        conversation.conversationType,
        conversation.name,
        new Date(conversation.createdAt),
        updatedAt
      )
    )
  );
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

  const conversationId = uuidv4();
  const createdAt = nowDate();
  const updatedAt = createdAt;
  const normalizedName = params.name?.trim() ? params.name.trim() : null;

  await cassandra.execute(
    `INSERT INTO conversations (conversation_id, conversation_type, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [toUuid(conversationId), params.conversationType, normalizedName, toUuid(params.requesterId), createdAt, updatedAt],
    { prepare: true }
  );

  await Promise.all(
    participants.map(async (participantId) => {
      await cassandra.execute(
        `INSERT INTO participants_by_conversation (conversation_id, user_id, joined_at)
         VALUES (?, ?, ?)`,
        [toUuid(conversationId), toUuid(participantId), createdAt],
        { prepare: true }
      );
      await upsertConversationUserIndex(
        participantId,
        conversationId,
        params.conversationType,
        normalizedName,
        createdAt,
        updatedAt
      );
    })
  );

  const record: ConversationRecord = {
    conversationId,
    conversationType: params.conversationType,
    name: normalizedName,
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

  const joinedAt = nowDate();
  await cassandra.execute(
    `INSERT INTO participants_by_conversation (conversation_id, user_id, joined_at)
     VALUES (?, ?, ?)`,
    [toUuid(conversationId), toUuid(participantId), joinedAt],
    { prepare: true }
  );

  await upsertConversationUserIndex(
    participantId,
    conversationId,
    conversation.conversationType,
    conversation.name,
    new Date(conversation.createdAt),
    new Date(conversation.updatedAt)
  );

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
  await cassandra.execute(
    `DELETE FROM conversations WHERE conversation_id = ?`,
    [toUuid(conversationId)],
    { prepare: true }
  );
  await cassandra.execute(
    `DELETE FROM participants_by_conversation WHERE conversation_id = ?`,
    [toUuid(conversationId)],
    { prepare: true }
  );
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

  await cassandra.execute(
    `DELETE FROM participants_by_conversation WHERE conversation_id = ? AND user_id = ?`,
    [toUuid(conversationId), toUuid(userId)],
    { prepare: true }
  );
  await cassandra.execute(
    `DELETE FROM conversations_by_user WHERE user_id = ? AND conversation_id = ?`,
    [toUuid(userId), toUuid(conversationId)],
    { prepare: true }
  );

  const remainingParticipants = await listParticipantIds(conversationId);

  await publishDmEvent({
    type: "dm:participant:leave",
    conversationId,
    participantIds: [...remainingParticipants, userId],
    userId,
    conversationDeleted: remainingParticipants.length === 0,
  });

  if (remainingParticipants.length === 0) {
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
  const nextCursor = messages.length === params.limit ? result.rows[result.rows.length - 1].get("created_at").toString() : null;

  return { messages, nextCursor };
};
