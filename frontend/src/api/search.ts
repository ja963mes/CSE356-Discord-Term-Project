export interface SearchResult {
  message_id: string;
  scope_type: "channel" | "dm";
  scope_id: string;
  community_id: string | null;
  channel_name: string | null;
  author_id: string;
  author_username: string;
  content: string;
  created_at: string;
  highlight: string;
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
}

export interface SearchParams {
  q: string;
  scope: "community" | "dm";
  communityId?: string;
  conversationId?: string;
  authorId?: string;
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
}

export async function searchMessages(params: SearchParams): Promise<SearchResponse> {
  const query = new URLSearchParams();
  query.set("q", params.q);
  query.set("scope", params.scope);
  if (params.communityId) query.set("communityId", params.communityId);
  if (params.conversationId) query.set("conversationId", params.conversationId);
  if (params.authorId) query.set("authorId", params.authorId);
  if (params.before) query.set("before", params.before);
  if (params.after) query.set("after", params.after);
  if (params.limit) query.set("limit", String(params.limit));
  if (params.offset) query.set("offset", String(params.offset));

  const res = await fetch(`/search/messages?${query.toString()}`, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Search failed (${res.status})`);
  }
  return (await res.json()) as SearchResponse;
}
