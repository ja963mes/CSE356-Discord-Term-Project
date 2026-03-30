export type Channel = {
  id: string;
  name: string;
  type: "text" | "voice" | string;
  position?: number;
  is_private?: boolean;
  /** Present when listing from API: user has channel_members row (can read history). */
  joined?: boolean;
};

export type Message = { id: string; author: string; content: string; ts: string };

export type SearchResult = { id: string; type: string; title: string; snippet: string; score: number };

export type Community = { id: string; name: string; created_at: string; role?: string };

export type CommunityMember = {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  joined_at: string;
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

const sampleMessagesByChannel: Record<string, Message[]> = {
  "general-chat": [
    {
      id: "m1",
      author: "Neo_Architect",
      content: "Welcome to the sanctuary. Wireframes are live.",
      ts: new Date().toISOString(),
    },
    {
      id: "m2",
      author: "Guest",
      content: "If the stub services aren't running, the UI should still look right.",
      ts: new Date().toISOString(),
    },
  ],
  "design-critique": [
    {
      id: "m3",
      author: "Neo_Architect",
      content: "Next: refine spacing scale and typography hierarchy.",
      ts: new Date().toISOString(),
    },
  ],
};

function fallbackMessages(channelId: string): Message[] {
  return (
    sampleMessagesByChannel[channelId] ?? [
      {
        id: "m-fallback-1",
        author: "Neo_Architect",
        content: "Sample message data (stub unavailable).",
        ts: new Date().toISOString(),
      },
    ]
  );
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

export async function getMessages(channelId: string): Promise<Message[]> {
  try {
    const res = await fetch(`/messages?channelId=${encodeURIComponent(channelId)}`);
    if (!res.ok) throw new Error("Failed to load messages");
    const body = (await res.json()) as { messages: Message[] };
    return body.messages;
  } catch {
    return fallbackMessages(channelId);
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
