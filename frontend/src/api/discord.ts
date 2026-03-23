export type Channel = { id: string; name: string; type: "text" | "voice" };

export type Message = { id: string; author: string; content: string; ts: string };

export type SearchResult = { id: string; type: string; title: string; snippet: string; score: number };

const sampleChannels: Channel[] = [
  { id: "general-chat", name: "general-chat", type: "text" },
  { id: "design-critique", name: "design-critique", type: "text" },
  { id: "resources", name: "resources", type: "text" },
  { id: "main-lounge", name: "Main Lounge", type: "voice" },
  { id: "pair-programming", name: "Pair Programming", type: "voice" },
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

