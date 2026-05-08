import { Client } from "@elastic/elasticsearch";
import { env } from "./env";

export const esClient = new Client({ node: env.ELASTICSEARCH_URL });

const INDEX = env.ES_INDEX_NAME;

const INDEX_SETTINGS = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
  },
  mappings: {
    properties: {
      message_id: { type: "keyword" as const },
      scope_type: { type: "keyword" as const },
      scope_id: { type: "keyword" as const },
      community_id: { type: "keyword" as const },
      channel_name: { type: "keyword" as const },
      author_id: { type: "keyword" as const },
      author_username: { type: "keyword" as const },
      content: { type: "text" as const },
      created_at: { type: "date" as const },
      updated_at: { type: "date" as const },
      is_deleted: { type: "boolean" as const },
    },
  },
};

export async function ensureIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: INDEX });
  if (!exists) {
    await esClient.indices.create({ index: INDEX, ...INDEX_SETTINGS });
    console.log(`[search] Created ES index "${INDEX}"`);
  } else {
    // Always update mapping so new/changed fields are applied
    await esClient.indices.putMapping({
      index: INDEX,
      ...INDEX_SETTINGS.mappings,
    });
    console.log(`[search] ES index "${INDEX}" already exists — mapping updated`);
  }
}

export type MessageDoc = {
  message_id: string;
  scope_type: "channel" | "dm";
  scope_id: string;
  community_id: string | null;
  channel_name: string | null;
  author_id: string;
  author_username: string;
  content: string;
  created_at: string;
  updated_at?: string | null;
  is_deleted: boolean;
};

export async function indexMessage(doc: MessageDoc): Promise<void> {
  await esClient.index({
    index: INDEX,
    id: doc.message_id,
    document: doc,
    refresh: false,
  });
}

export async function updateContent(messageId: string, content: string, editedAt: string): Promise<void> {
  try {
    await esClient.update({
      index: INDEX,
      id: messageId,
      doc: { content, updated_at: editedAt },
      refresh: false,
    });
  } catch (err: any) {
    if (err?.meta?.statusCode === 404) return;
    throw err;
  }
}

export async function markDeleted(messageId: string): Promise<void> {
  try {
    await esClient.update({
      index: INDEX,
      id: messageId,
      doc: { is_deleted: true, content: "" },
      refresh: false,
    });
  } catch (err: any) {
    if (err?.meta?.statusCode === 404) return;
    throw err;
  }
}

export async function deleteByScope(scopeId: string): Promise<void> {
  await esClient.deleteByQuery({
    index: INDEX,
    query: { term: { scope_id: scopeId } },
  });
}

export type SearchParams = {
  query: string;
  scopeIds: string[];
  scopeType: "channel" | "dm";
  communityId?: string;
  authorId?: string;
  before?: string;
  after?: string;
  limit: number;
  offset: number;
};

export type SearchResult = {
  message_id: string;
  scope_type: string;
  scope_id: string;
  community_id: string | null;
  channel_name: string | null;
  author_id: string;
  author_username: string;
  content: string;
  created_at: string;
  highlight: string;
};

export async function searchMessages(params: SearchParams): Promise<{ total: number; results: SearchResult[] }> {
  if (params.scopeIds.length === 0) {
    return { total: 0, results: [] };
  }

  // operator:"and" — every query term must match. Default OR returned docs
  // matching any single word, e.g. "akko lavender purple" hit a doc with only
  // "purple". prefix_length pins the first character so fuzziness:1 doesn't
  // drift the leading letter.
  const must: object[] = [
    {
      match: {
        content: {
          query: params.query,
          operator: "and",
          fuzziness: 1,
          prefix_length: 1,
        },
      },
    },
  ];

  const filter: object[] = [
    { terms: { scope_id: params.scopeIds } },
    { term: { is_deleted: false } },
  ];

  if (params.authorId) {
    filter.push({ term: { author_id: params.authorId } });
  }

  const range: Record<string, string> = {};
  if (params.after) range.gte = params.after;
  if (params.before) range.lte = params.before;
  if (Object.keys(range).length > 0) {
    filter.push({ range: { created_at: range } });
  }

  const body = await esClient.search({
    index: INDEX,
    query: { bool: { must, filter } },
    sort: [{ created_at: { order: "desc" } }],
    highlight: { fields: { content: { fragment_size: 200, number_of_fragments: 1 } } },
    size: params.limit,
    from: params.offset,
  });

  const totalValue = body.hits.total;
  const total = typeof totalValue === "number" ? totalValue : totalValue?.value ?? 0;

  const results: SearchResult[] = body.hits.hits.map((hit) => {
    const src = hit._source as MessageDoc;
    const hl = hit.highlight?.content?.[0] ?? src.content;
    return {
      message_id: src.message_id,
      scope_type: src.scope_type,
      scope_id: src.scope_id,
      community_id: src.community_id,
      channel_name: src.channel_name,
      author_id: src.author_id,
      author_username: src.author_username,
      content: src.content,
      created_at: src.created_at,
      highlight: hl,
    };
  });

  return { total, results };
}
