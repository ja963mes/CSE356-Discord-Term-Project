import { types } from "cassandra-driver";
import { cassandra, readConsistency, writeConsistency } from "./cassandra";
import { env } from "./env";

const ks = () => env.MESSAGES_CASSANDRA_KEYSPACE;

export type ChannelMessageRow = {
  messageId: string;
  createdAt: types.TimeUuid;
  authorId: string;
  authorUsername: string;
  content: string;
  editedAt: Date | null;
  attachmentKeys: string[];
};

export async function insertChannelMessage(params: {
  channelId: string;
  communityId: string;
  authorId: string;
  authorUsername: string;
  content: string;
  attachmentKeys?: string[];
}): Promise<{ messageId: string; createdAt: types.TimeUuid }> {
  const createdAt = types.TimeUuid.now();
  const messageId = types.Uuid.random();
  await cassandra.execute(
    `INSERT INTO ${ks()}.messages_by_channel
       (channel_id, created_at, message_id, community_id, author_id, author_username, content, is_deleted, attachment_keys)
     VALUES (?, ?, ?, ?, ?, ?, ?, false, ?)`,
    [
      types.Uuid.fromString(params.channelId),
      createdAt,
      messageId,
      types.Uuid.fromString(params.communityId),
      types.Uuid.fromString(params.authorId),
      params.authorUsername,
      params.content,
      params.attachmentKeys ?? [],
    ],
    { prepare: true, consistency: writeConsistency }
  );
  return { messageId: messageId.toString(), createdAt };
}

/** Fetch a single message by its timeuuid cursor — used for ownership checks before edit/delete. */
export async function getChannelMessage(
  channelId: string,
  createdAt: types.TimeUuid
): Promise<{ messageId: string; authorId: string; content: string } | null> {
  const result = await cassandra.execute(
    `SELECT message_id, author_id, content, is_deleted FROM ${ks()}.messages_by_channel
     WHERE channel_id = ? AND created_at = ?`,
    [types.Uuid.fromString(channelId), createdAt],
    { prepare: true, consistency: readConsistency }
  );
  const row = result.rows[0];
  if (!row || row.get("is_deleted") === true) return null;
  return {
    messageId: row.get("message_id").toString(),
    authorId: row.get("author_id").toString(),
    content: String(row.get("content") ?? ""),
  };
}

export async function editChannelMessage(params: {
  channelId: string;
  createdAt: types.TimeUuid;
  messageId: string;
  newContent: string;
}): Promise<void> {
  await cassandra.execute(
    `UPDATE ${ks()}.messages_by_channel
     SET content = ?, edited_at = toTimestamp(now())
     WHERE channel_id = ? AND created_at = ? AND message_id = ?`,
    [
      params.newContent,
      types.Uuid.fromString(params.channelId),
      params.createdAt,
      types.Uuid.fromString(params.messageId),
    ],
    { prepare: true, consistency: writeConsistency }
  );
}

export async function deleteChannelMessage(params: {
  channelId: string;
  createdAt: types.TimeUuid;
  messageId: string;
}): Promise<void> {
  await cassandra.execute(
    `UPDATE ${ks()}.messages_by_channel
     SET is_deleted = true, content = '', attachment_keys = ?
     WHERE channel_id = ? AND created_at = ? AND message_id = ?`,
    [
      [],
      types.Uuid.fromString(params.channelId),
      params.createdAt,
      types.Uuid.fromString(params.messageId),
    ],
    { prepare: true, consistency: writeConsistency }
  );
}

export async function listChannelMessages(
  channelId: string,
  limit: number,
  before: types.TimeUuid | null
): Promise<ChannelMessageRow[]> {
  const cid = types.Uuid.fromString(channelId);
  const query = before
    ? `SELECT message_id, created_at, author_id, author_username, content, edited_at, attachment_keys, is_deleted
       FROM ${ks()}.messages_by_channel
       WHERE channel_id = ? AND created_at < ? LIMIT ?`
    : `SELECT message_id, created_at, author_id, author_username, content, edited_at, attachment_keys, is_deleted
       FROM ${ks()}.messages_by_channel
       WHERE channel_id = ? LIMIT ?`;
  const params = before ? [cid, before, limit] : [cid, limit];
  const result = await cassandra.execute(query, params, { prepare: true, consistency: readConsistency });
  return result.rows
    .filter((row) => row.get("is_deleted") !== true)
    .map((row) => ({
      messageId: row.get("message_id").toString(),
      createdAt: row.get("created_at") as types.TimeUuid,
      authorId: row.get("author_id").toString(),
      authorUsername: String(row.get("author_username") ?? ""),
      content: String(row.get("content") ?? ""),
      editedAt: row.get("edited_at") ?? null,
      attachmentKeys: (row.get("attachment_keys") as string[] | null) ?? [],
    }));
}
