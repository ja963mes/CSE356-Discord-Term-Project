export type Channel = { id: string; name: string; type: "text" | "voice" };

export type Message = { id: string; author: string; content: string; ts: string };

export type SearchResult = { id: string; type: string; title: string; snippet: string; score: number };

export type Community = { id: string; name: string; created_at: string };

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
