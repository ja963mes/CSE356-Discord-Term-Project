import { uuidv4, uuidv5 } from "../uuid";
import { publishDmEvent } from "../events";
import { keyToUrl } from "../minio";
import { logger } from "../logger";
import {
  ConversationRecord,
  ConversationType,
  deleteConversation,
  getConversation,
  insertConversation,
  insertParticipants,
  isParticipant,
  listConversationsForUser,
  listParticipantIds,
  removeParticipant,
  touchConversation,
} from "./participants";
import {
  DmMessageRow,
  deleteAllMessagesForConversation,
  editDmMessage,
  getDmMessageByTimeuuid,
  insertDmMessage,
  listDmMessages,
  softDeleteDmMessage,
} from "./repo";

export type { ConversationType, ConversationRecord };

/** Public shape for a message returned over HTTP. */
export type MessageRecord = {
  messageId: string;
  conversationId: string;
  authorId: string;
  content: string;
  attachmentKeys: string[];
  attachmentUrls: string[];
  createdAt: string;
  timeuuid: string;
  updatedAt: string | null;
  deleted: boolean;
};

export class DmError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

const MAX_ATTACHMENTS = 4;
const MAX_CONTENT_LEN = 4000;

/** Deterministic one-to-one conversation id — same pair always hashes to same UUID. */
const oneToOneConversationId = (a: string, b: string): string =>
  uuidv5([a, b].sort().join(":"), uuidv5.URL);

function toMessageRecord(row: DmMessageRow): MessageRecord {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    authorId: row.authorId,
    content: row.content,
    attachmentKeys: row.attachmentKeys,
    attachmentUrls: row.attachmentKeys.map(keyToUrl),
    createdAt: new Date(row.createdAt.getDate().getTime()).toISOString(),
    timeuuid: row.createdAt.toString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deleted: row.isDeleted,
  };
}

async function publishSafe(event: Parameters<typeof publishDmEvent>[0]): Promise<void> {
  try {
    await publishDmEvent(event);
  } catch (err) {
    logger.error({ err, eventType: event.type }, "publishDmEvent failed");
  }
}

// ─── Conversations ───────────────────────────────────────────────────────────

export async function listConversations(userId: string): Promise<ConversationRecord[]> {
  return listConversationsForUser(userId);
}

export async function createConversation(params: {
  requesterId: string;
  conversationType: ConversationType;
  participantIds: string[];
  name?: string | null;
}): Promise<ConversationRecord> {
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
  const createdAt = new Date();
  const normalizedName = params.name?.trim() ? params.name.trim() : null;

  const wasInserted = await insertConversation({
    conversationId,
    conversationType: params.conversationType,
    name: normalizedName,
    createdBy: params.requesterId,
    createdAt,
  });

  await insertParticipants({ conversationId, userIds: participants, joinedAt: createdAt });

  let record: ConversationRecord;
  if (!wasInserted) {
    await touchConversation(conversationId);
    const existing = await getConversation(conversationId);
    if (!existing) {
      throw new DmError(500, "Conversation insert raced with deletion");
    }
    existing.participantIds = await listParticipantIds(conversationId);
    record = existing;
    logger.info({ conversationId, requesterId: params.requesterId }, "conversation rejoined");
  } else {
    record = {
      conversationId,
      conversationType: params.conversationType,
      name: normalizedName,
      participantIds: participants,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
    };
    logger.info(
      { conversationId, type: params.conversationType, participants: participants.length },
      "conversation created"
    );
  }

  await publishSafe({
    type: "dm:conversation:create",
    conversationId,
    participantIds: record.participantIds,
    conversation: {
      conversationId: record.conversationId,
      conversationType: record.conversationType,
      name: record.name,
      participantIds: record.participantIds,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  });

  return record;
}

export async function inviteParticipant(
  conversationId: string,
  inviterId: string,
  participantId: string
): Promise<void> {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new DmError(404, "Conversation not found");
  if (conversation.conversationType !== "group") {
    throw new DmError(400, "Can only invite users to a group conversation");
  }
  if (!(await isParticipant(conversationId, inviterId))) {
    throw new DmError(403, "Only participants can invite users");
  }
  if (await isParticipant(conversationId, participantId)) return;

  await insertParticipants({ conversationId, userIds: [participantId], joinedAt: new Date() });
  await touchConversation(conversationId);

  const participantIds = await listParticipantIds(conversationId);
  logger.info({ conversationId, inviterId, participantId }, "participant invited");

  await publishSafe({
    type: "dm:participant:join",
    conversationId,
    participantIds,
    userId: participantId,
  });
}

export async function leaveConversation(
  conversationId: string,
  userId: string
): Promise<{ deleted: boolean }> {
  const conversation = await getConversation(conversationId);
  if (!conversation) throw new DmError(404, "Conversation not found");
  if (!(await isParticipant(conversationId, userId))) {
    throw new DmError(403, "You are not a participant in this conversation");
  }

  await removeParticipant(conversationId, userId);

  const remainingParticipants = await listParticipantIds(conversationId);
  const shouldDelete = remainingParticipants.length === 0 && conversation.conversationType === "group";

  await publishSafe({
    type: "dm:participant:leave",
    conversationId,
    participantIds: [...remainingParticipants, userId],
    userId,
    conversationDeleted: shouldDelete,
  });

  if (shouldDelete) {
    // Delete Cassandra side first — if PG delete fails after, the messages are gone
    // but the conversation row remains and can be retried; the opposite leaves orphaned
    // message rows in Cassandra forever (the phantom-row class of bug).
    await deleteAllMessagesForConversation(conversationId);
    await deleteConversation(conversationId);
    logger.info({ conversationId }, "empty group conversation deleted");
    return { deleted: true };
  }

  await touchConversation(conversationId);
  logger.info({ conversationId, userId }, "participant left");
  return { deleted: false };
}

// ─── Messages ────────────────────────────────────────────────────────────────

export async function createMessage(params: {
  conversationId: string;
  authorId: string;
  content: string;
  attachmentKeys: string[];
}): Promise<MessageRecord> {
  const [conversation, isMember, participantIds] = await Promise.all([
    getConversation(params.conversationId),
    isParticipant(params.conversationId, params.authorId),
    listParticipantIds(params.conversationId),
  ]);
  if (!conversation) throw new DmError(404, "Conversation not found");
  if (!isMember) throw new DmError(403, "Only participants can post messages");

  const content = params.content.trim();
  if (!content) throw new DmError(400, "Message content cannot be empty");
  if (content.length > MAX_CONTENT_LEN) {
    throw new DmError(400, `content must be at most ${MAX_CONTENT_LEN} characters`);
  }
  if (params.attachmentKeys.length > MAX_ATTACHMENTS) {
    throw new DmError(400, `A message can have at most ${MAX_ATTACHMENTS} attachments`);
  }

  const { messageId, createdAt } = await insertDmMessage({
    conversationId: params.conversationId,
    authorId: params.authorId,
    content,
    attachmentKeys: params.attachmentKeys,
  });

  // Fire-and-forget: not on critical path for client response.
  void touchConversation(params.conversationId).catch((err) =>
    logger.warn({ err, conversationId: params.conversationId }, "touchConversation failed")
  );

  const messageRecord: MessageRecord = {
    messageId,
    conversationId: params.conversationId,
    authorId: params.authorId,
    content,
    attachmentKeys: params.attachmentKeys,
    attachmentUrls: params.attachmentKeys.map(keyToUrl),
    createdAt: new Date(createdAt.getDate().getTime()).toISOString(),
    timeuuid: createdAt.toString(),
    updatedAt: null,
    deleted: false,
  };

  logger.info(
    {
      conversationId: params.conversationId,
      messageId,
      authorId: params.authorId,
      attachmentCount: params.attachmentKeys.length,
    },
    "dm message stored"
  );

  await publishSafe({
    type: "dm:message:create",
    conversationId: params.conversationId,
    participantIds,
    message: {
      messageId,
      authorId: params.authorId,
      content,
      attachments: messageRecord.attachmentUrls,
      createdAt: messageRecord.createdAt,
      timeuuid: messageRecord.timeuuid,
    },
  });

  return messageRecord;
}

export async function listMessages(params: {
  conversationId: string;
  userId: string;
  limit: number;
  before?: string;
}): Promise<{ messages: MessageRecord[]; nextCursor: string | null }> {
  if (!(await isParticipant(params.conversationId, params.userId))) {
    throw new DmError(403, "Only participants can view conversation history");
  }

  const { messages, lastRowTimeuuid } = await listDmMessages({
    conversationId: params.conversationId,
    limit: params.limit,
    before: params.before,
  });

  return {
    messages: messages.map(toMessageRecord),
    nextCursor: lastRowTimeuuid,
  };
}

export async function editMessage(params: {
  conversationId: string;
  authorId: string;
  timeuuid: string;
  content: string;
}): Promise<MessageRecord> {
  if (!(await isParticipant(params.conversationId, params.authorId))) {
    throw new DmError(403, "Only participants can edit messages");
  }

  const content = params.content.trim();
  if (!content) throw new DmError(400, "Message content cannot be empty");
  if (content.length > MAX_CONTENT_LEN) {
    throw new DmError(400, `content must be at most ${MAX_CONTENT_LEN} characters`);
  }

  const existing = await getDmMessageByTimeuuid(params.conversationId, params.timeuuid);
  if (!existing) throw new DmError(404, "Message not found");
  if (existing.isDeleted) throw new DmError(400, "This message was deleted");
  if (existing.authorId !== params.authorId) {
    throw new DmError(403, "Only the author can edit this message");
  }

  const updatedAt = new Date();
  await editDmMessage({
    conversationId: params.conversationId,
    timeuuid: params.timeuuid,
    messageId: existing.messageId,
    newContent: content,
    updatedAt,
  });

  logger.info(
    { conversationId: params.conversationId, messageId: existing.messageId, authorId: params.authorId },
    "dm message edited"
  );

  const participantIds = await listParticipantIds(params.conversationId);
  await publishSafe({
    type: "dm:message:edit",
    conversationId: params.conversationId,
    participantIds,
    message: {
      messageId: existing.messageId,
      authorId: params.authorId,
      content,
      createdAt: new Date(existing.createdAt.getDate().getTime()).toISOString(),
      updatedAt: updatedAt.toISOString(),
      timeuuid: params.timeuuid,
    },
  });

  return {
    messageId: existing.messageId,
    conversationId: params.conversationId,
    authorId: params.authorId,
    content,
    attachmentKeys: existing.attachmentKeys,
    attachmentUrls: existing.attachmentKeys.map(keyToUrl),
    createdAt: new Date(existing.createdAt.getDate().getTime()).toISOString(),
    timeuuid: params.timeuuid,
    updatedAt: updatedAt.toISOString(),
    deleted: false,
  };
}

export async function deleteMessage(params: {
  conversationId: string;
  authorId: string;
  timeuuid: string;
}): Promise<void> {
  if (!(await isParticipant(params.conversationId, params.authorId))) {
    throw new DmError(403, "Only participants can delete messages");
  }

  const existing = await getDmMessageByTimeuuid(params.conversationId, params.timeuuid);
  if (!existing) throw new DmError(404, "Message not found");
  if (existing.isDeleted) return;
  if (existing.authorId !== params.authorId) {
    throw new DmError(403, "Only the author can delete this message");
  }

  const deletedAt = new Date();
  await softDeleteDmMessage({
    conversationId: params.conversationId,
    timeuuid: params.timeuuid,
    messageId: existing.messageId,
    deletedAt,
  });

  logger.info(
    { conversationId: params.conversationId, messageId: existing.messageId, authorId: params.authorId },
    "dm message deleted"
  );

  const participantIds = await listParticipantIds(params.conversationId);
  await publishSafe({
    type: "dm:message:delete",
    conversationId: params.conversationId,
    participantIds,
    messageId: existing.messageId,
    id: existing.messageId,
    authorId: params.authorId,
    timeuuid: params.timeuuid,
    message: {
      id: existing.messageId,
      messageId: existing.messageId,
      timeuuid: params.timeuuid,
      authorId: params.authorId,
    },
  });
}
