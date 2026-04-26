import { types as cassandraTypes } from "cassandra-driver";
import { cassandra, readConsistency, writeConsistency } from "../cassandra";
import { kvCacheRedis } from "../redis";

const RS_LATEST_TTL_SEC = 7 * 24 * 60 * 60;

const toUuid = (value: string): cassandraTypes.Uuid => cassandraTypes.Uuid.fromString(value);
const toTimeUuid = (value: string): cassandraTypes.TimeUuid => cassandraTypes.TimeUuid.fromString(value);

export type DmMessageRow = {
  messageId: string;
  conversationId: string;
  authorId: string;
  content: string;
  attachmentKeys: string[];
  createdAt: cassandraTypes.TimeUuid;
  updatedAt: Date | null;
  isDeleted: boolean;
};

/**
 * Rows with `author_id IS NULL` are "phantom" — partial upserts from an UPDATE
 * that ran without a prior INSERT (e.g. an edit racing an out-of-order write).
 * We treat them as nonexistent throughout the service.
 */
function rowToMessage(row: cassandraTypes.Row): DmMessageRow | null {
  const authorCol = row.get("author_id");
  if (authorCol == null) return null;
  const createdAt = row.get("created_at") as cassandraTypes.TimeUuid;
  const isDeleted = row.get("is_deleted") === true;
  const attachmentKeys: string[] = isDeleted ? [] : ((row.get("attachment_keys") as string[] | null) ?? []);
  return {
    messageId: row.get("message_id").toString(),
    conversationId: row.get("conversation_id").toString(),
    authorId: authorCol.toString(),
    content: isDeleted ? "" : String(row.get("content") ?? ""),
    attachmentKeys,
    createdAt,
    updatedAt: (row.get("updated_at") as Date | null) ?? null,
    isDeleted,
  };
}

export async function insertDmMessage(params: {
  conversationId: string;
  authorId: string;
  content: string;
  attachmentKeys: string[];
}): Promise<{ messageId: string; createdAt: cassandraTypes.TimeUuid }> {
  const createdAt = cassandraTypes.TimeUuid.now();
  const messageId = cassandraTypes.Uuid.random();
  await cassandra.execute(
    `INSERT INTO messages_by_conversation
       (conversation_id, created_at, message_id, author_id, content, attachment_keys, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, false)`,
    [
      toUuid(params.conversationId),
      createdAt,
      messageId,
      toUuid(params.authorId),
      params.content,
      params.attachmentKeys,
    ],
    { prepare: true, consistency: writeConsistency }
  );
  // Cache latest timeuuid so read-state can skip messages_by_conversation LIMIT 1.
  kvCacheRedis
    .set(`rs:latest:dm:${params.conversationId}`, createdAt.toString(), "EX", RS_LATEST_TTL_SEC)
    .catch(() => {});
  return { messageId: messageId.toString(), createdAt };
}

export async function getDmMessageByTimeuuid(
  conversationId: string,
  timeuuid: string
): Promise<DmMessageRow | null> {
  const result = await cassandra.execute(
    `SELECT conversation_id, created_at, message_id, author_id, content, attachment_keys, updated_at, is_deleted
     FROM messages_by_conversation
     WHERE conversation_id = ? AND created_at = ?`,
    [toUuid(conversationId), toTimeUuid(timeuuid)],
    { prepare: true, consistency: readConsistency }
  );
  const row = result.rows[0];
  return row ? rowToMessage(row) : null;
}

export async function editDmMessage(params: {
  conversationId: string;
  timeuuid: string;
  messageId: string;
  newContent: string;
  updatedAt: Date;
}): Promise<void> {
  await cassandra.execute(
    `UPDATE messages_by_conversation
     SET content = ?, updated_at = ?
     WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [
      params.newContent,
      params.updatedAt,
      toUuid(params.conversationId),
      toTimeUuid(params.timeuuid),
      toUuid(params.messageId),
    ],
    { prepare: true, consistency: writeConsistency }
  );
}

export async function softDeleteDmMessage(params: {
  conversationId: string;
  timeuuid: string;
  messageId: string;
  deletedAt: Date;
}): Promise<void> {
  await cassandra.execute(
    `UPDATE messages_by_conversation
     SET is_deleted = true, content = '', attachment_keys = ?, updated_at = ?
     WHERE conversation_id = ? AND created_at = ? AND message_id = ?`,
    [
      [] as string[],
      params.deletedAt,
      toUuid(params.conversationId),
      toTimeUuid(params.timeuuid),
      toUuid(params.messageId),
    ],
    { prepare: true, consistency: writeConsistency }
  );
}

export async function listDmMessages(params: {
  conversationId: string;
  limit: number;
  before?: string;
}): Promise<{ messages: DmMessageRow[]; lastRowTimeuuid: string | null }> {
  const queryParts = [
    `SELECT conversation_id, created_at, message_id, author_id, content, attachment_keys, updated_at, is_deleted`,
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

  const result = await cassandra.execute(queryParts.join(" "), values, {
    prepare: true,
    consistency: readConsistency,
  });

  const mapped = result.rows.map(rowToMessage).filter((r): r is DmMessageRow => r !== null && !r.isDeleted);
  const lastRawRow = result.rows[result.rows.length - 1];
  const lastRowTimeuuid =
    result.rows.length === params.limit && lastRawRow
      ? (lastRawRow.get("created_at") as cassandraTypes.TimeUuid).toString()
      : null;
  return { messages: mapped, lastRowTimeuuid };
}

export async function deleteAllMessagesForConversation(conversationId: string): Promise<void> {
  await cassandra.execute(
    `DELETE FROM messages_by_conversation WHERE conversation_id = ?`,
    [toUuid(conversationId)],
    { prepare: true, consistency: writeConsistency }
  );
}
