/**
 * Community directory reads: Elasticsearch only (`searchCommunitiesDirectory`).
 * Postgres is used only to **reindex** into ES (`reindexAllCommunitiesFromPostgres`) and for
 * create/update events — not for live search queries.
 */
import { esClient } from "./elasticsearch";
import { env } from "./env";
import { db } from "./db";
import { communities } from "./db/schema";

export const COMMUNITIES_INDEX = env.ES_COMMUNITIES_INDEX_NAME;

const COMMUNITIES_MAPPINGS = {
  properties: {
    community_id: { type: "keyword" as const },
    /** Whole-field wildcard + case_insensitive; ignore_above raised for long display names. */
    name: { type: "keyword" as const, ignore_above: 32766 },
    created_at: { type: "date" as const },
  },
};

export async function ensureCommunitiesIndex(): Promise<void> {
  const exists = await esClient.indices.exists({ index: COMMUNITIES_INDEX });
  if (!exists) {
    await esClient.indices.create({
      index: COMMUNITIES_INDEX,
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: COMMUNITIES_MAPPINGS,
    });
    console.log(`[search] Created ES communities index "${COMMUNITIES_INDEX}"`);
  } else {
    await esClient.indices.putMapping({
      index: COMMUNITIES_INDEX,
      ...COMMUNITIES_MAPPINGS,
    });
  }
}

export type CommunityDirDoc = {
  community_id: string;
  name: string;
  created_at: string;
};

export async function indexCommunityDirectory(doc: CommunityDirDoc): Promise<void> {
  await esClient.index({
    index: COMMUNITIES_INDEX,
    id: doc.community_id,
    document: doc,
    refresh: true,
  });
}

export async function deleteCommunityDirectory(communityId: string): Promise<void> {
  try {
    await esClient.delete({ index: COMMUNITIES_INDEX, id: communityId, refresh: true });
  } catch (err: unknown) {
    const status = (err as { meta?: { statusCode?: number } })?.meta?.statusCode;
    if (status === 404) return;
    throw err;
  }
}

/** Escape `*`, `?`, `\` for Elasticsearch `wildcard` query values. */
function escapeEsWildcard(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\*/g, "\\*").replace(/\?/g, "\\?");
}

export async function searchCommunitiesDirectory(
  q: string,
  limit: number,
): Promise<Array<{ id: string; name: string; created_at: string }>> {
  const pattern = `*${escapeEsWildcard(q)}*`;
  const res = await esClient.search({
    index: COMMUNITIES_INDEX,
    query: {
      bool: {
        must: [{ wildcard: { name: { value: pattern, case_insensitive: true } } }],
      },
    },
    sort: [{ created_at: { order: "desc" } }],
    size: limit,
  });

  return (res.hits.hits as Array<{ _source: CommunityDirDoc }>).map((hit) => {
    const src = hit._source;
    return {
      id: src.community_id,
      name: src.name,
      created_at: src.created_at,
    };
  });
}

/** Full reload from Postgres (startup / recovery). */
export async function reindexAllCommunitiesFromPostgres(): Promise<number> {
  const rows = await db
    .select({
      id: communities.id,
      name: communities.name,
      created_at: communities.created_at,
    })
    .from(communities);

  for (const row of rows) {
    const created =
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    await indexCommunityDirectory({
      community_id: row.id,
      name: row.name,
      created_at: created,
    });
  }
  return rows.length;
}
