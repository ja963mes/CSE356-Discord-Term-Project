export type ConversationType = "one_to_one" | "group";

export type Conversation = {
  conversationId: string;
  conversationType: ConversationType;
  name: string | null;
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
  lastReadTimeuuid?: string | null;
  hasUnread?: boolean;
};

export type ConversationReadState = {
  userId: string;
  lastReadMessageId: string | null;
  lastReadTimeuuid: string | null;
};

export type DmMessage = {
  messageId: string;
  conversationId: string;
  authorId: string;
  content: string;
  attachmentKeys: string[];
  attachmentUrls: string[];
  createdAt: string;
  /** Cassandra clustering key — required for edit/delete */
  timeuuid: string;
  updatedAt: string | null;
  deleted?: boolean;
};

async function fetchApi<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listConversations(): Promise<Conversation[]> {
  const data = await fetchApi<{ conversations: Conversation[] }>("/dms");
  return data.conversations;
}

export async function createConversation(params: {
  type: ConversationType;
  participantIds: string[];
  name?: string;
}): Promise<Conversation> {
  const data = await fetchApi<{ conversation: Conversation }>("/dms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return data.conversation;
}

export async function inviteParticipant(conversationId: string, userId: string): Promise<void> {
  await fetchApi(`/dms/${conversationId}/participants`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

export async function leaveConversation(conversationId: string): Promise<{ deleted: boolean }> {
  return fetchApi<{ deleted: boolean }>(`/dms/${conversationId}/participants/me`, {
    method: "DELETE",
  });
}

export async function sendMessage(
  conversationId: string,
  content: string,
  attachmentKeys: string[] = []
): Promise<DmMessage> {
  const data = await fetchApi<{ message: DmMessage }>(`/dms/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, attachmentKeys }),
  });
  return data.message;
}

export async function listMessages(
  conversationId: string,
  params?: { limit?: number; before?: string }
): Promise<{ messages: DmMessage[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.before) query.set("before", params.before);
  const qs = query.toString();
  return fetchApi(`/dms/${conversationId}/messages${qs ? `?${qs}` : ""}`);
}

export async function editMessage(
  conversationId: string,
  content: string,
  timeuuid: string
): Promise<DmMessage> {
  const data = await fetchApi<{ message: DmMessage }>(
    `/dms/${conversationId}/messages/${encodeURIComponent(timeuuid)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }
  );
  return data.message;
}

export async function deleteMessage(conversationId: string, timeuuid: string): Promise<void> {
  await fetchApi(`/dms/${conversationId}/messages/${encodeURIComponent(timeuuid)}`, {
    method: "DELETE",
  });
}

export async function getDmReadState(): Promise<Array<{
  conversationId: string;
  lastReadMessageId: string | null;
  lastReadTimeuuid: string | null;
  hasUnread: boolean;
}>> {
  const data = await fetchApi<{ conversations: Array<{
    conversationId: string;
    lastReadMessageId: string | null;
    lastReadTimeuuid: string | null;
    hasUnread: boolean;
  }> }>("/read-state/dms");
  return data.conversations;
}

export async function getConversationReadState(conversationId: string): Promise<ConversationReadState[]> {
  const data = await fetchApi<{ readState: ConversationReadState[] }>(`/read-state/dms/${conversationId}`);
  return data.readState;
}

export async function markConversationRead(conversationId: string, timeuuid: string): Promise<void> {
  await fetchApi(`/read-state/dms/${conversationId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timeuuid }),
  });
}
