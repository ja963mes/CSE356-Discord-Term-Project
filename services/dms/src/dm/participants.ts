import { and, eq, inArray } from "drizzle-orm";
import { pg } from "../db/pg";
import { directConversations, dmParticipants } from "../db/pgSchema";

export type ConversationType = "one_to_one" | "group";

export type ConversationRecord = {
  conversationId: string;
  conversationType: ConversationType;
  name: string | null;
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
};

export async function getConversation(conversationId: string): Promise<ConversationRecord | null> {
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
}

export async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const rows = await pg
    .select({ user_id: dmParticipants.user_id })
    .from(dmParticipants)
    .where(and(eq(dmParticipants.conversation_id, conversationId), eq(dmParticipants.user_id, userId)))
    .limit(1);
  return rows.length > 0;
}

export async function listParticipantIds(conversationId: string): Promise<string[]> {
  const rows = await pg
    .select({ user_id: dmParticipants.user_id })
    .from(dmParticipants)
    .where(eq(dmParticipants.conversation_id, conversationId));
  return rows.map((r) => r.user_id);
}

export async function listConversationsForUser(userId: string): Promise<ConversationRecord[]> {
  const userRows = await pg
    .select({ conversation_id: dmParticipants.conversation_id })
    .from(dmParticipants)
    .where(eq(dmParticipants.user_id, userId));

  if (userRows.length === 0) return [];

  const convIds = userRows.map((r) => r.conversation_id);

  const [conversations, allParticipants] = await Promise.all([
    pg.select().from(directConversations).where(inArray(directConversations.id, convIds)),
    pg.select().from(dmParticipants).where(inArray(dmParticipants.conversation_id, convIds)),
  ]);

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
}

export async function insertConversation(params: {
  conversationId: string;
  conversationType: ConversationType;
  name: string | null;
  createdBy: string;
  createdAt: Date;
}): Promise<boolean> {
  const inserted = await pg
    .insert(directConversations)
    .values({
      id: params.conversationId,
      type: params.conversationType,
      name: params.name,
      created_by: params.createdBy,
      created_at: params.createdAt,
      updated_at: params.createdAt,
    })
    .onConflictDoNothing()
    .returning();
  return inserted.length > 0;
}

export async function insertParticipants(params: {
  conversationId: string;
  userIds: string[];
  joinedAt: Date;
}): Promise<void> {
  if (params.userIds.length === 0) return;
  await pg
    .insert(dmParticipants)
    .values(
      params.userIds.map((uid) => ({
        conversation_id: params.conversationId,
        user_id: uid,
        joined_at: params.joinedAt,
      }))
    )
    .onConflictDoNothing();
}

export async function removeParticipant(conversationId: string, userId: string): Promise<void> {
  await pg
    .delete(dmParticipants)
    .where(and(eq(dmParticipants.conversation_id, conversationId), eq(dmParticipants.user_id, userId)));
}

export async function deleteConversation(conversationId: string): Promise<void> {
  // dm_participants cascades via FK ON DELETE CASCADE
  await pg.delete(directConversations).where(eq(directConversations.id, conversationId));
}

export async function touchConversation(conversationId: string): Promise<void> {
  await pg.update(directConversations).set({ updated_at: new Date() }).where(eq(directConversations.id, conversationId));
}
