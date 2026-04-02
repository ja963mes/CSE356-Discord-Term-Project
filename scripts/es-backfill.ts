/**
 * One-time backfill: reads all messages from Cassandra and indexes them into Elasticsearch.
 * Idempotent (upserts by message_id).
 *
 * Usage:  npx tsx scripts/es-backfill.ts
 */

import dotenv from "dotenv";
import path from "path";
import { Client as EsClient } from "@elastic/elasticsearch";
import { Client as CassandraClient, auth } from "cassandra-driver";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(__dirname, "../.env") });
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const DATABASE_URL = process.env.DATABASE_URL!;
const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL ?? "http://localhost:9200";
const ES_INDEX = process.env.ES_INDEX_NAME ?? "messages";

const CASSANDRA_CONTACT_POINTS = (process.env.CASSANDRA_CONTACT_POINTS ?? "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
const CASSANDRA_PORT = Number(process.env.CASSANDRA_PORT ?? 9042);
const CASSANDRA_DC = process.env.CASSANDRA_LOCAL_DATACENTER ?? "datacenter1";
const CASSANDRA_USER = process.env.CASSANDRA_USERNAME;
const CASSANDRA_PASS = process.env.CASSANDRA_PASSWORD;
const MESSAGES_KEYSPACE = process.env.MESSAGES_CASSANDRA_KEYSPACE ?? "messaging";
const DMS_KEYSPACE = process.env.CASSANDRA_KEYSPACE ?? "dms";

const BATCH_SIZE = 500;

const credentials =
  CASSANDRA_USER && CASSANDRA_PASS
    ? new auth.PlainTextAuthProvider(CASSANDRA_USER, CASSANDRA_PASS)
    : undefined;

async function main() {
  // ── Clients ──
  const pg = new Pool({ connectionString: DATABASE_URL });
  const es = new EsClient({ node: ELASTICSEARCH_URL });

  // Connect without keyspace first to check which keyspaces exist
  const cassandraBase = new CassandraClient({
    contactPoints: CASSANDRA_CONTACT_POINTS,
    localDataCenter: CASSANDRA_DC,
    protocolOptions: { port: CASSANDRA_PORT },
    authProvider: credentials,
  });
  await cassandraBase.connect();

  const ksResult = await cassandraBase.execute("SELECT keyspace_name FROM system_schema.keyspaces");
  const existingKeyspaces = new Set(ksResult.rows.map((r) => r.get("keyspace_name") as string));
  await cassandraBase.shutdown();

  const hasMessaging = existingKeyspaces.has(MESSAGES_KEYSPACE);
  const hasDms = existingKeyspaces.has(DMS_KEYSPACE);

  let messagingCassandra: CassandraClient | null = null;
  let dmsCassandra: CassandraClient | null = null;

  if (hasMessaging) {
    messagingCassandra = new CassandraClient({
      contactPoints: CASSANDRA_CONTACT_POINTS,
      localDataCenter: CASSANDRA_DC,
      keyspace: MESSAGES_KEYSPACE,
      protocolOptions: { port: CASSANDRA_PORT },
      authProvider: credentials,
    });
    await messagingCassandra.connect();
  } else {
    console.log(`Keyspace "${MESSAGES_KEYSPACE}" does not exist — skipping channel messages`);
  }

  if (hasDms) {
    dmsCassandra = new CassandraClient({
      contactPoints: CASSANDRA_CONTACT_POINTS,
      localDataCenter: CASSANDRA_DC,
      keyspace: DMS_KEYSPACE,
      protocolOptions: { port: CASSANDRA_PORT },
      authProvider: credentials,
    });
    await dmsCassandra.connect();
  } else {
    console.log(`Keyspace "${DMS_KEYSPACE}" does not exist — skipping DM messages`);
  }

  // ── Pre-load username map ──
  const usernameMap = new Map<string, string>();
  const userRows = await pg.query<{ internal_id: string; username: string }>("SELECT internal_id, username FROM users");
  for (const row of userRows.rows) {
    usernameMap.set(row.internal_id, row.username);
  }
  console.log(`Loaded ${usernameMap.size} users`);

  // ── Pre-load channel info ──
  const channelRows = await pg.query<{ id: string; community_id: string; name: string }>(
    "SELECT id, community_id, name FROM channels"
  );
  const channelMap = new Map<string, { communityId: string; name: string }>();
  for (const row of channelRows.rows) {
    channelMap.set(row.id, { communityId: row.community_id, name: row.name });
  }
  console.log(`Loaded ${channelMap.size} channels`);

  // ── Pre-load DM conversations ──
  let conversationIds: string[] = [];
  try {
    const convRows = await pg.query<{ id: string }>("SELECT id FROM direct_conversations");
    conversationIds = convRows.rows.map((r) => r.id);
    console.log(`Loaded ${conversationIds.length} DM conversations`);
  } catch {
    console.log("direct_conversations table does not exist — skipping DM messages");
  }

  let totalIndexed = 0;

  // ── Backfill channel messages ──
  if (messagingCassandra) {
    console.log("\n--- Backfilling channel messages ---");
    for (const [channelId, info] of channelMap) {
      const result = await messagingCassandra.execute(
        `SELECT message_id, created_at, author_id, author_username, content FROM messages_by_channel WHERE channel_id = ?`,
        [channelId],
        { prepare: true, fetchSize: BATCH_SIZE }
      );

      const docs: any[] = [];
      for (const row of result.rows) {
        const createdAt = row.get("created_at");
        docs.push({
          message_id: row.get("message_id").toString(),
          scope_type: "channel",
          scope_id: channelId,
          community_id: info.communityId,
          channel_name: info.name,
          author_id: row.get("author_id").toString(),
          author_username: String(row.get("author_username") ?? "unknown"),
          content: String(row.get("content") ?? ""),
          created_at: createdAt.getDate().toISOString(),
          is_deleted: false,
        });
      }

      if (docs.length > 0) {
        await bulkIndex(es, docs);
        totalIndexed += docs.length;
        console.log(`  Channel ${info.name} (${channelId}): ${docs.length} messages`);
      }
    }
  }

  // ── Backfill DM messages ──
  if (dmsCassandra) {
    console.log("\n--- Backfilling DM messages ---");
    for (const convId of conversationIds) {
      const result = await dmsCassandra.execute(
        `SELECT conversation_id, message_id, created_at, author_id, content, is_deleted, updated_at FROM messages_by_conversation WHERE conversation_id = ?`,
        [convId],
        { prepare: true, fetchSize: BATCH_SIZE }
      );

      const docs: any[] = [];
      for (const row of result.rows) {
        const authorId = row.get("author_id").toString();
        const isDeleted = row.get("is_deleted") === true;
        const createdAt = row.get("created_at");
        const updatedAt = row.get("updated_at") as Date | null;

        docs.push({
          message_id: row.get("message_id").toString(),
          scope_type: "dm",
          scope_id: convId,
          community_id: null,
          channel_name: null,
          author_id: authorId,
          author_username: usernameMap.get(authorId) ?? "unknown",
          content: isDeleted ? "" : String(row.get("content") ?? ""),
          created_at: createdAt.getDate().toISOString(),
          updated_at: updatedAt?.toISOString() ?? null,
          is_deleted: isDeleted,
        });
      }

      if (docs.length > 0) {
        await bulkIndex(es, docs);
        totalIndexed += docs.length;
        console.log(`  DM conversation ${convId}: ${docs.length} messages`);
      }
    }
  }

  console.log(`\nBackfill complete. Total documents indexed: ${totalIndexed}`);

  if (messagingCassandra) await messagingCassandra.shutdown();
  if (dmsCassandra) await dmsCassandra.shutdown();
  await pg.end();
}

async function bulkIndex(es: EsClient, docs: any[]): Promise<void> {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const body = batch.flatMap((doc: any) => [
      { index: { _index: process.env.ES_INDEX_NAME ?? "messages", _id: doc.message_id } },
      doc,
    ]);
    const result = await es.bulk({ body });
    if (result.errors) {
      const errors = result.items.filter((item: any) => item.index?.error);
      console.error(`  Bulk index errors: ${errors.length}`);
    }
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
