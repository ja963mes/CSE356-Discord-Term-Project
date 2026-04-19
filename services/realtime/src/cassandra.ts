import { Client, types } from "cassandra-driver";
import { env } from "./env";

function toUuid(value: string): types.Uuid {
  return types.Uuid.fromString(value);
}

function toTimeUuid(value: string): types.TimeUuid {
  return types.TimeUuid.fromString(value);
}

export type DmMessageRow = {
  conversationId: string;
  messageId: string;
  authorId: string;
  content: string;
  timeuuid: string;
  createdAtIso: string;
  attachmentKeys: string[];
  updatedAtIso: string | null;
  isDeleted: boolean;
};

export const cassandra = new Client({
  contactPoints: env.CASSANDRA_CONTACT_POINTS.split(",").map((s) => s.trim()).filter(Boolean),
  localDataCenter: env.CASSANDRA_LOCAL_DATACENTER,
  protocolOptions: { port: env.CASSANDRA_PORT },
});

export async function initCassandra(): Promise<void> {
  await cassandra.connect();
}

export async function getLastReadTimeuuidForDm(userId: string, conversationId: string): Promise<string | null> {
  const result = await cassandra.execute(
    "SELECT last_read_timeuuid FROM read_state.dm_state_by_user WHERE user_id = ? AND conversation_id = ?",
    [toUuid(userId), toUuid(conversationId)],
    { prepare: true }
  );
  return result.rows[0]?.get("last_read_timeuuid")?.toString() ?? null;
}

export async function getLatestDmTimeuuid(conversationId: string): Promise<string | null> {
  const result = await cassandra.execute(
    "SELECT created_at FROM dms.messages_by_conversation WHERE conversation_id = ? LIMIT 1",
    [toUuid(conversationId)],
    { prepare: true }
  );
  return result.rows[0]?.get("created_at")?.toString() ?? null;
}

export async function listDmMessagesNewerThan(params: {
  conversationId: string;
  afterTimeuuid: string | null;
  limit: number;
}): Promise<DmMessageRow[]> {
  const { conversationId, afterTimeuuid, limit } = params;

  const query = afterTimeuuid
    ? "SELECT created_at, message_id, author_id, content, attachment_keys, updated_at, is_deleted FROM dms.messages_by_conversation WHERE conversation_id = ? AND created_at > ? LIMIT ?"
    : "SELECT created_at, message_id, author_id, content, attachment_keys, updated_at, is_deleted FROM dms.messages_by_conversation WHERE conversation_id = ? LIMIT ?";

  const values = afterTimeuuid
    ? [toUuid(conversationId), toTimeUuid(afterTimeuuid), limit]
    : [toUuid(conversationId), limit];

  const result = await cassandra.execute(query, values, { prepare: true });

  return result.rows.map((row) => {
    const createdAt = row.get("created_at") as types.TimeUuid;
    const updatedAt = row.get("updated_at") as Date | null;
    return {
      conversationId,
      timeuuid: createdAt.toString(),
      createdAtIso: new Date(createdAt.getDate().getTime()).toISOString(),
      messageId: row.get("message_id")?.toString(),
      authorId: row.get("author_id")?.toString(),
      content: row.get("content") ?? "",
      attachmentKeys: (row.get("attachment_keys") as string[] | null) ?? [],
      updatedAtIso: updatedAt ? updatedAt.toISOString() : null,
      isDeleted: Boolean(row.get("is_deleted") ?? false),
    };
  });
}

