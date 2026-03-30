import { types } from "cassandra-driver";
import { cassandra, readConsistency, writeConsistency } from "./cassandra";
import { env } from "./env";

const ks = () => env.MESSAGES_CASSANDRA_KEYSPACE;

export async function insertChannelMessage(params: {
  channelId: string;
  communityId: string;
  authorId: string;
  authorUsername: string;
  content: string;
}): Promise<{ messageId: string; createdAt: types.TimeUuid }> {
  const createdAt = types.TimeUuid.now();
  const messageId = types.Uuid.random();
  await cassandra.execute(
    `INSERT INTO ${ks()}.messages_by_channel (channel_id, created_at, message_id, community_id, author_id, author_username, content) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      types.Uuid.fromString(params.channelId),
      createdAt,
      messageId,
      types.Uuid.fromString(params.communityId),
      types.Uuid.fromString(params.authorId),
      params.authorUsername,
      params.content,
    ],
    { prepare: true, consistency: writeConsistency }
  );
  return { messageId: messageId.toString(), createdAt };
}

export type ChannelMessageRow = {
  messageId: string;
  createdAt: types.TimeUuid;
  authorUsername: string;
  content: string;
};

export async function listChannelMessages(
  channelId: string,
  limit: number,
  before: types.TimeUuid | null
): Promise<ChannelMessageRow[]> {
  const cid = types.Uuid.fromString(channelId);
  const query = before
    ? `SELECT message_id, created_at, author_username, content FROM ${ks()}.messages_by_channel WHERE channel_id = ? AND created_at < ? LIMIT ?`
    : `SELECT message_id, created_at, author_username, content FROM ${ks()}.messages_by_channel WHERE channel_id = ? LIMIT ?`;
  const params = before ? [cid, before, limit] : [cid, limit];
  const result = await cassandra.execute(query, params, { prepare: true, consistency: readConsistency });
  return result.rows.map((row) => ({
    messageId: row.get("message_id").toString(),
    createdAt: row.get("created_at") as types.TimeUuid,
    authorUsername: String(row.get("author_username") ?? ""),
    content: String(row.get("content") ?? ""),
  }));
}
