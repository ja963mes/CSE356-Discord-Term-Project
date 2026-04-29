export type Channel = {
  id: string;
  name: string;
  type: "text" | "voice" | string;
  position?: number;
  is_private?: boolean;
  /** Present when listing from API: user has channel_members row (can read history). */
  joined?: boolean;
};

export type Message = {
  id: string;           // messageId from backend
  timeuuid: string;
  authorId: string;
  author: string;       // authorUsername
  content: string;
  createdAt: string;
  editedAt: string | null;
  attachmentKeys: string[];
  attachmentUrls: string[];
  deleted?: boolean;
};

export type SearchResult = { id: string; type: string; title: string; snippet: string; score: number };

export type Community = { id: string; name: string; created_at: string; role?: string };

export type CommunityMember = {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  joined_at: string;
};

export type ChannelAccessMember = {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
};

export type ChannelReadState = {
  channelId: string;
  lastReadMessageId: string | null;
  lastReadTimeuuid: string | null;
  mentionCount: number;
  hasUnread: boolean;
};

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(input, { ...init, credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** List communities for the logged-in user (requires session). Returns null if unauthenticated or error. */
export async function listCommunities(): Promise<Community[] | null> {
  const body = await fetchJson<{ communities: Community[] }>("/communities");
  return body?.communities ?? null;
}

export async function getCommunityChannels(communityId: string): Promise<Channel[] | null> {
  const body = await fetchJson<{ channels: Channel[] }>(`/communities/${encodeURIComponent(communityId)}/channels`);
  return body?.channels ?? null;
}

export async function getCommunityMembers(communityId: string): Promise<CommunityMember[] | null> {
  const body = await fetchJson<{ members: CommunityMember[] }>(`/communities/${encodeURIComponent(communityId)}/members`);
  return body?.members ?? null;
}

export async function getChannelMembers(
  communityId: string,
  channelId: string
): Promise<ChannelAccessMember[] | null> {
  const body = await fetchJson<{ members: ChannelAccessMember[] }>(
    `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/members`
  );
  return body?.members ?? null;
}

/** Search all public communities by name. */
export async function searchCommunities(q: string): Promise<Community[] | null> {
  const body = await fetchJson<{ communities: Community[] }>(`/search-communities?q=${encodeURIComponent(q)}`);
  return body?.communities ?? null;
}

export type JoinCommunityResult =
  | { ok: true; status: "joined" | "already" }
  | { ok: false; error: string };

/** Join a community (open join; session required). Uses communities service. */
export async function joinCommunity(communityId: string): Promise<JoinCommunityResult> {
  try {
    const res = await fetch(`/communities/${encodeURIComponent(communityId)}/join`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (res.status === 201) return { ok: true, status: "joined" };
    if (res.status === 200) return { ok: true, status: "already" };
    if (res.status === 404) return { ok: false, error: "Community not found." };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "You must be signed in to join." };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? "Could not join this server." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export type LeaveCommunityResult = { ok: true } | { ok: false; error: string };

/** Leave a community (membership removed). Uses communities service. */
export async function leaveCommunity(communityId: string): Promise<LeaveCommunityResult> {
  try {
    const res = await fetch(`/communities/${encodeURIComponent(communityId)}/leave`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? "Cannot leave this server." };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "You must be signed in." };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? "Could not leave this server." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

export type ChannelMutationOk = { ok: true } | { ok: false; error: string };
export type AddChannelMemberResult =
  | { ok: true; status: "added" | "already_member" }
  | { ok: false; error: string };

export type CreateChannelResult = { ok: true; channel: Channel } | { ok: false; error: string };

/** Create a channel (owner/admin). */
export async function createChannel(
  communityId: string,
  body: { name: string; type?: string; is_private?: boolean; position?: number }
): Promise<CreateChannelResult> {
  try {
    const res = await fetch(`/communities/${encodeURIComponent(communityId)}/channels`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { channel?: Channel; error?: string };
    if (res.status === 201 && data.channel) return { ok: true, channel: data.channel };
    return { ok: false, error: data.error ?? "Could not create channel." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

/** Delete a channel (owner/admin; cannot delete last channel). */
export async function deleteChannel(communityId: string, channelId: string): Promise<ChannelMutationOk> {
  try {
    const res = await fetch(
      `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}`,
      { method: "DELETE", credentials: "include" }
    );
    if (res.status === 204) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Could not delete channel." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

/** Join a public channel (must be a guild member). */
export async function joinChannel(communityId: string, channelId: string): Promise<ChannelMutationOk> {
  try {
    const res = await fetch(
      `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/join`,
      { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } }
    );
    if (res.status === 201) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Could not join channel." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

/** Leave a channel (drops channel_members). */
export async function leaveChannel(communityId: string, channelId: string): Promise<ChannelMutationOk> {
  try {
    const res = await fetch(
      `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/leave`,
      { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" } }
    );
    if (res.status === 200) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Could not leave channel." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

/** Add one community member to a private channel (owner/admin only). */
export async function addChannelMember(
  communityId: string,
  channelId: string,
  userId: string
): Promise<AddChannelMemberResult> {
  try {
    const res = await fetch(
      `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/members`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      }
    );
    if (res.status === 201) return { ok: true, status: "added" };
    if (res.status === 200) return { ok: true, status: "already_member" };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Could not add member to channel." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

/** Remove one member's access from a private channel (owner/admin only). */
export async function removeChannelMember(
  communityId: string,
  channelId: string,
  userId: string
): Promise<ChannelMutationOk> {
  try {
    const res = await fetch(
      `/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`,
      {
        method: "DELETE",
        credentials: "include",
      }
    );
    if (res.status === 204) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "Could not remove member from channel." };
  } catch {
    return { ok: false, error: "Network error." };
  }
}

const sampleChannels: Channel[] = [
  { id: "general-chat", name: "general-chat", type: "text" },
  { id: "design-critique", name: "design-critique", type: "text" },
  { id: "resources", name: "resources", type: "text" },
  { id: "main-lounge", name: "Main Lounge", type: "voice" },
  { id: "pair-programming", name: "Pair Programming", type: "voice" },
];

const sampleMembers: CommunityMember[] = [
  {
    user_id: "sample-1",
    username: "neo_architect",
    display_name: "Neo_Architect",
    role: "owner",
    joined_at: new Date().toISOString(),
  },
  {
    user_id: "sample-2",
    username: "guest",
    display_name: "Guest",
    role: "member",
    joined_at: new Date().toISOString(),
  },
  {
    user_id: "sample-3",
    username: "design_bot",
    display_name: "Design Bot",
    role: "member",
    joined_at: new Date().toISOString(),
  },
  {
    user_id: "sample-4",
    username: "offline_user",
    display_name: "Offline User",
    role: "member",
    joined_at: new Date().toISOString(),
  },
];

function makeSample(id: string, author: string, content: string): Message {
  return { id, timeuuid: id, authorId: "sample", author, content, createdAt: new Date().toISOString(), editedAt: null, attachmentKeys: [], attachmentUrls: [] };
}

const sampleMessagesByChannel: Record<string, Message[]> = {
  "general-chat": [
    makeSample("m1", "Neo_Architect", "Welcome to the sanctuary. Wireframes are live."),
    makeSample("m2", "Guest", "If the stub services aren't running, the UI should still look right."),
  ],
  "design-critique": [
    makeSample("m3", "Neo_Architect", "Next: refine spacing scale and typography hierarchy."),
  ],
};

function fallbackMessages(channelId: string): Message[] {
  return sampleMessagesByChannel[channelId] ?? [
    makeSample("m-fallback-1", "Neo_Architect", "Sample message data (stub unavailable)."),
  ];
}

/**
 * Legacy wireframe path: tries GET /channels on the messages/community stub.
 * Prefer loading channels via getCommunityChannels when you have a community id.
 */
export async function getChannels(): Promise<Channel[]> {
  try {
    const res = await fetch("/channels");
    if (!res.ok) throw new Error("Failed to load channels");
    const body = (await res.json()) as { channels: Channel[] };
    return body.channels;
  } catch {
    return sampleChannels;
  }
}

function looksLikeChannelUuid(channelId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId);
}

/** Load channel messages (session required for real channel UUIDs). */
export async function getMessages(channelId: string, params?: { before?: string; limit?: number }): Promise<Message[]> {
  try {
    const query = new URLSearchParams({ channelId });
    if (params?.before) query.set("before", params.before);
    if (params?.limit) query.set("limit", String(params.limit));
    const res = await fetch(`/messages?${query.toString()}`, { credentials: "include" });
    if (res.status === 401 || res.status === 403) return [];
    if (!res.ok) throw new Error("Failed to load messages");
    const body = (await res.json()) as { messages: Message[] };
    return body.messages;
  } catch {
    if (!looksLikeChannelUuid(channelId)) return fallbackMessages(channelId);
    return [];
  }
}

/** Post to a guild text channel (session + channel_members required). */
export async function postChannelMessage(
  channelId: string,
  content: string,
  attachmentKeys: string[] = []
): Promise<Message | null> {
  const text = content.trim();
  if (!text) return null;
  try {
    const res = await fetch("/messages", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId, content: text, attachmentKeys }),
    });
    if (res.status === 201) {
      const data = (await res.json()) as { message: Message };
      return data.message ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Edit own channel message. */
export async function editChannelMessage(
  channelId: string,
  timeuuid: string,
  content: string
): Promise<Message | null> {
  try {
    const res = await fetch(`/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(timeuuid)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { messageId: string; timeuuid: string; content: string; editedAt: string };
    return { id: data.messageId, timeuuid: data.timeuuid, authorId: "", author: "", content: data.content, createdAt: "", editedAt: data.editedAt, attachmentKeys: [], attachmentUrls: [] };
  } catch {
    return null;
  }
}

/** Delete own channel message. */
export async function deleteChannelMessage(channelId: string, timeuuid: string): Promise<boolean> {
  try {
    const res = await fetch(`/messages/${encodeURIComponent(channelId)}/${encodeURIComponent(timeuuid)}`, {
      method: "DELETE",
      credentials: "include",
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

export async function getChannelReadState(communityId: string): Promise<ChannelReadState[] | null> {
  const body = await fetchJson<{ channels: ChannelReadState[] }>(
    `/read-state/channels?communityId=${encodeURIComponent(communityId)}`
  );
  return body?.channels ?? null;
}

export async function markChannelRead(channelId: string, messageId: string, timeuuid: string): Promise<boolean> {
  try {
    const res = await fetch(`/read-state/channels/${encodeURIComponent(channelId)}/read`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, timeuuid }),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

export type PresignedFile = { key: string; uploadUrl: string };

/** Get presigned PUT URLs for direct MinIO uploads. */
export async function presignAttachments(
  files: { filename: string; contentType: string }[]
): Promise<PresignedFile[]> {
  const res = await fetch("/attachments/presign", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error("Failed to get presigned URLs");
  const data = (await res.json()) as { files: PresignedFile[] };
  return data.files;
}

/** Upload a file directly to MinIO using a presigned PUT URL. */
export async function uploadToMinIO(uploadUrl: string, file: File): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function getSampleChannels(): Channel[] {
  return sampleChannels;
}

export function getSampleMembers(): CommunityMember[] {
  return sampleMembers;
}

export async function search(q: string): Promise<SearchResult[]> {
  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error("Search failed");
    const body = (await res.json()) as { results: SearchResult[] };
    return body.results;
  } catch {
    const query = q.trim();
    if (!query) return [];
    return [
      {
        id: "s-fallback-1",
        type: "message",
        title: `Sample result for "${query}"`,
        snippet: "Search service not running yet; showing fallback content.",
        score: 1.0,
      },
    ];
  }
}
