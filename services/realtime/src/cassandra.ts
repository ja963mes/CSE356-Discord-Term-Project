import { Client, types } from "cassandra-driver";
import { env } from "./env";

function toUuid(value: string): types.Uuid {
  return types.Uuid.fromString(value);
}

function toTimeUuid(value: string): types.TimeUuid {
  return types.TimeUuid.fromString(value);
}

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

export type DmCatchupRow = {
  conversationId: string;
  messageId: string;
  authorId: string;
  timeuuid: string;
};

export async function listDmMessagesNewerThanTimestamp(params: {
  conversationId: string;
  sinceMs: number;
  limit: number;
}): Promise<DmCatchupRow[]> {
  const { conversationId, sinceMs, limit } = params;
  const minTimeuuid = types.TimeUuid.fromDate(new Date(sinceMs));
  const result = await cassandra.execute(
    "SELECT created_at, message_id, author_id FROM dms.messages_by_conversation WHERE conversation_id = ? AND created_at > ? LIMIT ?",
    [toUuid(conversationId), minTimeuuid, limit],
    { prepare: true }
  );
  const out: DmCatchupRow[] = [];
  for (const row of result.rows) {
    const createdAt = row.get("created_at") as types.TimeUuid | null;
    const messageId = row.get("message_id");
    const authorId = row.get("author_id");
    if (!createdAt || messageId == null || authorId == null) continue;
    out.push({
      conversationId,
      timeuuid: createdAt.toString(),
      messageId: messageId.toString(),
      authorId: authorId.toString(),
    });
  }
  return out;
}

export async function listDmMessagesNewerThan(params: {
  conversationId: string;
  afterTimeuuid: string | null;
  limit: number;
}): Promise<DmCatchupRow[]> {
  const { conversationId, afterTimeuuid, limit } = params;
  const result = afterTimeuuid
    ? await cassandra.execute(
        "SELECT created_at, message_id, author_id FROM dms.messages_by_conversation WHERE conversation_id = ? AND created_at > ? LIMIT ?",
        [toUuid(conversationId), toTimeUuid(afterTimeuuid), limit],
        { prepare: true }
      )
    : await cassandra.execute(
        "SELECT created_at, message_id, author_id FROM dms.messages_by_conversation WHERE conversation_id = ? LIMIT ?",
        [toUuid(conversationId), limit],
        { prepare: true }
      );

  const out: DmCatchupRow[] = [];
  for (const row of result.rows) {
    const createdAt = row.get("created_at") as types.TimeUuid | null;
    const messageId = row.get("message_id");
    const authorId = row.get("author_id");
    // Skip phantom / soft-delete rows that have no author or no message id.
    // These appear because UPDATE upserts leave a row with only the touched
    // columns + PK populated; sending them would push a useless hint with
    // authorId/messageId = undefined to the client.
    if (!createdAt || messageId == null || authorId == null) continue;
    out.push({
      conversationId,
      timeuuid: createdAt.toString(),
      messageId: messageId.toString(),
      authorId: authorId.toString(),
    });
  }
  return out;
}

