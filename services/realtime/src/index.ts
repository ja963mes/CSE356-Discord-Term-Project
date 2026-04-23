import http from "http";
import cluster from "cluster";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookie } from "cookie";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { env } from "./env";
import { initDb, pg } from "./db";
import {
  registerConnection,
  removeConnection,
  hasRegisteredConnections,
  updateActivity,
  setAway,
  clearAway,
  computePresence,
  PresenceStatus,
} from "./presence";
import { broadcastPresenceChange, PRESENCE_BROADCAST_CHANNEL, PresenceBroadcastMessage } from "./broadcast";
import {
  subscribeUser,
  unsubscribeUser,
  subscribeDm,
  unsubscribeDm,
  subscribeCommunity,
  unsubscribeCommunity,
  subscribeChannel,
  unsubscribeChannel,
  getPresenceTargets,
  subscribeAllChannelsForUserInCommunity,
  subscribeAllMembersForChannel,
} from "./subscriptions";
import { logger } from "./logger";
import { initCassandra, listDmMessagesNewerThanTimestamp } from "./cassandra";

// Unique ID for this instance — used to namespace presence:conns fields
// so multiple instances don't stomp on each other's connection data at startup
const instanceId = randomUUID();
// With cluster, only worker 1 registers in the instance registry so dms sees
// one entry per VM rather than N. All workers still subscribe to pubsub.
const shouldRegisterInstance = !cluster.isWorker || cluster.worker?.id === 1;
logger.info({ instanceId, workerId: cluster.worker?.id ?? "primary" }, "startup");

// Pubsub instance — `redis.publish(...)` for presence:broadcast, etc.
const redis = new Redis(env.REDIS_URL);
redis.on("connect", () => logger.info("redis (pubsub) connected"));
redis.on("error", (err) => logger.error({ err }, "redis (pubsub) error"));

// KV instance (port 6380) — sessions, presence:*, INSTANCE_REGISTRY,
// dm:pending:* drain. Separated from pubsub so KV ops aren't queued behind
// fanout on the single-threaded redis event loop.
const kvRedis = new Redis(env.KV_REDIS_URL);
kvRedis.on("connect", async () => {
  logger.info("redis (kv) connected");
  // Clear only this instance's stale connection fields from previous runs.
  // Use SCAN (not KEYS) to avoid blocking Redis during startup.
  let cursor = "0";
  let cleared = 0;
  do {
    const [next, keys] = await kvRedis.scan(cursor, "MATCH", "presence:conns:*", "COUNT", 200);
    cursor = next;
    if (keys.length === 0) continue;
    const pipeline = kvRedis.pipeline();
    for (const key of keys) pipeline.hkeys(key);
    const results = await pipeline.exec();
    const delPipeline = kvRedis.pipeline();
    let hasDeletes = false;
    results?.forEach((result, i) => {
      const fields = (result?.[1] as string[]) ?? [];
      const stale = fields.filter((f) => f.startsWith(`${instanceId}:`));
      if (stale.length > 0) {
        delPipeline.hdel(keys[i], ...stale);
        cleared += stale.length;
        hasDeletes = true;
      }
    });
    if (hasDeletes) await delPipeline.exec();
  } while (cursor !== "0");
  if (cleared > 0) logger.info({ cleared, instanceId }, "cleared stale presence fields");
});
kvRedis.on("error", (err) => logger.error({ err }, "redis (kv) error"));

// Dedicated Redis client for pub/sub (ioredis requires a separate connection for subscriptions)
const redisSub = new Redis(env.REDIS_URL);
redisSub.on("error", (err) => logger.error({ err }, "redis sub error"));

// Per-socket outbound queue limits
const WS_QUEUE_CAP_IMPORTANT = 512;     // kill connection if important-message queue exceeds this
const WS_QUEUE_CAP_BEST_EFFORT = 128;   // drop frame (no kill) if best-effort queue exceeds this
const WS_BACKPRESSURE_KILL_BYTES = 1 * 1024 * 1024; // 1 MB buffered → kill
const WS_DRAIN_BATCH = 64;              // max ws.send() calls per setImmediate tick
const WS_DEDUP_MAX = 512;               // max recent messageIds to track per socket

type ConnEntry = {
  ws: WebSocket;
  userId: string;
  recentMessageIds: Set<string>;
  outboundQueue: string[];
  draining: boolean;
  createdAtMs: number;
};

// Track active connections: connId -> ConnEntry
const connections = new Map<string, ConnEntry>();
// Reverse index: normalizedUserId -> Set<connId> for O(1) fanout lookup
const userConnections = new Map<string, Set<string>>();
// WebSocket → connId reverse lookup for enqueueSend called with only ws
const wsConnId = new WeakMap<WebSocket, string>();
const workerLabel = cluster.worker?.id ?? "primary";

/** Normalize user ids for Set membership (Postgres JSON vs session can differ in UUID case). */
function normUserId(id: string): string {
  return id.trim().toLowerCase();
}

/** Synchronously evict a connection from local maps then terminate the socket.
 *  The close event fires asynchronously after terminate(), running the Redis
 *  cleanup and writing the offline marker. Sync eviction ensures no further
 *  fanout reaches this socket before that happens. */
function removeLocalConnection(
  connId: string,
  ws: WebSocket,
  reason: string,
  extra?: Record<string, unknown>
): { existed: boolean; userId?: string; ageMs?: number; queueLen?: number } {
  const conn = connections.get(connId);
  connections.delete(connId);
  wsConnId.delete(ws);
  if (conn) {
    const normId = normUserId(conn.userId);
    const userConns = userConnections.get(normId);
    if (userConns) {
      userConns.delete(connId);
      if (userConns.size === 0) userConnections.delete(normId);
    }
    const ageMs = Date.now() - conn.createdAtMs;
    logger.info(
      {
        reason,
        connId,
        userId: conn.userId,
        queueLen: conn.outboundQueue.length,
        ageMs,
        readyState: ws.readyState,
        instanceId,
        workerId: workerLabel,
        ...extra,
      },
      "realtime connection removed from local maps"
    );
    return { existed: true, userId: conn.userId, ageMs, queueLen: conn.outboundQueue.length };
  }
  return { existed: false };
}

function evictAndTerminate(connId: string, ws: WebSocket, reason = "evict_and_terminate", extra?: Record<string, unknown>): void {
  removeLocalConnection(connId, ws, reason, extra);
  ws.terminate();
}

function scheduleFlush(connId: string): void {
  const conn = connections.get(connId);
  if (!conn || conn.draining) return;
  conn.draining = true;
  setImmediate(() => { flushQueue(connId); });
}

function flushQueue(connId: string): void {
  const conn = connections.get(connId);
  if (!conn) return; // evicted

  const { ws, outboundQueue } = conn;

  if (ws.readyState !== WebSocket.OPEN) {
    // A closing/closed socket can remain in local maps until the async close
    // handler runs. Evict immediately so subsequent DM fanout does not keep
    // selecting this stale connId and dropping important sends.
    evictAndTerminate(connId, ws, "flush_queue_non_open", { queueLen: outboundQueue.length });
    return;
  }

  // Drain up to WS_DRAIN_BATCH messages per tick then yield via setImmediate.
  // Keeps event loop responsive under burst (e.g. 200-user presence snapshot on
  // connect) without the old one-at-a-time stall that caused queue overflow.
  let sent = 0;
  while (outboundQueue.length > 0 && sent < WS_DRAIN_BATCH) {
    if (ws.bufferedAmount >= WS_BACKPRESSURE_KILL_BYTES) {
      logger.warn({ connId, userId: conn.userId, bufferedAmount: ws.bufferedAmount }, "ws backpressure kill");
      evictAndTerminate(connId, ws, "backpressure_kill", { bufferedAmount: ws.bufferedAmount, queueLen: outboundQueue.length });
      return;
    }

    const payload = outboundQueue.shift()!;
    try {
      ws.send(payload);
    } catch (err) {
      logger.warn({ err, connId, userId: conn.userId }, "ws send failed; terminating");
      evictAndTerminate(connId, ws, "send_failed", { queueLen: outboundQueue.length });
      return;
    }
    sent++;
  }

  if (outboundQueue.length > 0) {
    setImmediate(() => { flushQueue(connId); });
  } else {
    conn.draining = false;
  }
}

/**
 * Drain the per-user pending DM hint queue populated by the dms service
 * (dm:pending:<userId>). These are hints that were emitted while the user's
 * socket was either tearing down or had not yet reconnected. Drained
 * atomically via MULTI so a second concurrent reconnect (other tab) does
 * not replay the same hints. Clients still dedupe by messageId, so any
 * overlap with live fanout is harmless.
 */
async function drainPendingDmHints(ws: WebSocket, userId: string): Promise<void> {
  const key = `dm:pending:${userId}`;
  let rawEntries: string[] | null = null;
  try {
    const result = await kvRedis.multi().lrange(key, 0, -1).del(key).exec();
    // ioredis exec() returns Array<[err, result]> | null
    const first = result?.[0];
    if (Array.isArray(first) && Array.isArray(first[1])) {
      rawEntries = first[1] as string[];
    }
  } catch (err) {
    logger.warn({ err, userId }, "dm pending-queue drain failed");
    return;
  }
  if (!rawEntries || rawEntries.length === 0) return;

  // LPUSH + LRANGE 0 -1 returns newest-first. Replay oldest-first so
  // clients see hints in causal order.
  const ordered = [...rawEntries].reverse();
  logger.info({ userId, count: ordered.length }, "dm pending-queue drained");

  for (const raw of ordered) {
    if (ws.readyState !== WebSocket.OPEN) return;
    let hint: { type?: string; conversationId?: string; messageId?: string; authorId?: string; timeuuid?: string; message?: { messageId?: string } };
    try {
      hint = JSON.parse(raw);
    } catch {
      continue;
    }
    if (hint.type === "dm:message:create") {
      const msgId = hint.message?.messageId;
      if (!msgId) continue;
      const publishedAt = typeof (hint as { publishedAt?: unknown }).publishedAt === "number"
        ? (hint as { publishedAt: number }).publishedAt
        : undefined;
      logger.info(
        {
          userId,
          conversationId: hint.conversationId,
          messageId: msgId,
          publishedAt,
          recoveryLatencyMs: publishedAt !== undefined ? Date.now() - publishedAt : undefined,
          source: "pending",
          instanceId,
          workerId: workerLabel,
        },
        "dm pending-queue replaying message"
      );
      enqueueSend(ws, JSON.stringify({ ...hint, source: "pending" }), "dm_pending",
        { userId, conversationId: hint.conversationId, messageId: msgId }, true);
    } else if (hint.type === "dm:new_message") {
      // backward compat: old hints stored before this fix
      if (!hint.messageId || !hint.authorId) continue;
      enqueueSend(ws, JSON.stringify({ ...hint, source: "pending" }), "dm_pending",
        { userId, conversationId: hint.conversationId, messageId: hint.messageId }, true);
    }
  }
}

async function listUserDmConversationIds(userId: string): Promise<string[]> {
  const result = await pg.query<{ conversation_id: string }>(
    "SELECT conversation_id FROM dm_participants WHERE user_id = $1::uuid",
    [userId]
  );
  return result.rows.map((r) => String(r.conversation_id));
}

async function withRetry<T>(
  label: string,
  ctx: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { name?: string; info?: string };
    const isTimeout =
      e?.name === "OperationTimedOutError" ||
      (typeof e?.info === "string" && e.info.includes("did not reply before timeout"));
    if (!isTimeout) throw err;
    logger.warn({ err, label, ...ctx }, "cassandra timeout; retrying once");
    return await fn();
  }
}

async function replayMissedDmHintsFromDisconnect(
  ws: WebSocket,
  userId: string,
  disconnectedAt: number,
  closeCode: number
): Promise<void> {
  const replayStartedAt = Date.now();
  const MAX_CONVERSATIONS = 50;
  const CONCURRENCY = 5;
  // Abnormal closes (1006) are detected by heartbeat up to 25s late; use a
  // larger grace window so messages sent during the dead-socket window are
  // always included in the replay.
  const gracePeriodMs = closeCode === 1006 ? 30_000 : 5_000;
  const sinceMs = disconnectedAt - gracePeriodMs;

  let conversationIds: string[];
  try {
    conversationIds = await listUserDmConversationIds(userId);
  } catch (err) {
    logger.warn({ err, userId }, "dm catch-up failed to list conversations");
    return;
  }

  const queue = conversationIds.slice(0, MAX_CONVERSATIONS);
  logger.info({ userId, conversationCount: queue.length, sinceMs, gracePeriodMs, closeCode }, "dm catch-up started");
  let replayedMessageCount = 0;

  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < queue.length) {
      const i = idx++;
      if (ws.readyState !== WebSocket.OPEN) return;
      const conversationId = queue[i];
      let rows;
      try {
        rows = await withRetry("listDmMessagesNewerThanTimestamp", { userId, conversationId }, () =>
          listDmMessagesNewerThanTimestamp({ conversationId, sinceMs, limit: 50 })
        );
      } catch (err) {
        logger.warn({ err, userId, conversationId }, "dm catch-up failed to list messages");
        continue;
      }
      // Cassandra returns newest-first; replay oldest-first for causal order.
      for (const row of [...rows].reverse()) {
        if (ws.readyState !== WebSocket.OPEN) return;
        enqueueSend(
          ws,
          JSON.stringify({
            type: "dm:message:create",
            conversationId,
            participantIds: [],
            message: {
              messageId: row.messageId,
              authorId: row.authorId,
              content: row.content,
              attachments: row.attachments,
              timeuuid: row.timeuuid,
              createdAt: "",
            },
            source: "catchup",
          }),
          "dm_catchup",
          { userId, conversationId, messageId: row.messageId },
          true
        );
        replayedMessageCount++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  logger.info(
    {
      userId,
      conversationCount: queue.length,
      replayedMessageCount,
      durationMs: Date.now() - replayStartedAt,
      sinceMs,
      closeCode,
      instanceId,
      workerId: workerLabel,
    },
    "dm catch-up completed"
  );
}

function enqueueSend(
  ws: WebSocket,
  payload: string,
  label: string,
  ctx?: { userId?: string; connId?: string; conversationId?: string; messageId?: string },
  important = false
): void {
  const cid = wsConnId.get(ws);
  if (!cid) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch { /* best effort */ }
    }
    return;
  }
  const conn = connections.get(cid);
  if (!conn || ws.readyState !== WebSocket.OPEN) {
    let evicted = false;
    if (conn && ws.readyState !== WebSocket.OPEN) {
      evictAndTerminate(cid, ws, label === "dm_event" || label === "dm_shard" ? "enqueue_non_open_dm" : "enqueue_non_open", {
        label,
        ...ctx,
        queueLen: conn.outboundQueue.length,
      });
      evicted = true;
    }
    if (label === "dm_event" || label === "dm_shard") {
      logger.warn(
        {
          label,
          readyState: ws.readyState,
          queueLen: conn?.outboundQueue.length,
          connAgeMs: conn ? Date.now() - conn.createdAtMs : undefined,
          localConnectionPresent: Boolean(conn),
          evicted,
          instanceId,
          workerId: workerLabel,
          ...ctx,
        },
        "ws not open, dropping send"
      );
    }
    return;
  }
  // Dedup here (after open check) so a closing socket doesn't poison the set
  // and block subsequent delivery attempts via pubsub/catchup/pending paths.
  if (ctx?.messageId) {
    if (conn.recentMessageIds.has(ctx.messageId)) return;
    conn.recentMessageIds.add(ctx.messageId);
    if (conn.recentMessageIds.size > WS_DEDUP_MAX) conn.recentMessageIds.clear();
  }
  const cap = important ? WS_QUEUE_CAP_IMPORTANT : WS_QUEUE_CAP_BEST_EFFORT;
  if (conn.outboundQueue.length >= cap) {
    if (important) {
      logger.warn({ connId: cid, userId: conn.userId, queueLen: conn.outboundQueue.length }, "ws important queue full; killing connection");
      evictAndTerminate(cid, ws);
    }
    // best-effort: silently drop — presence/guild state reconciles eventually
    return;
  }
  conn.outboundQueue.push(payload);
  scheduleFlush(cid);
}

// Last known presence stored in Redis so multiple instances agree on state
async function getLastKnownPresence(userId: string): Promise<PresenceStatus> {
  return ((await kvRedis.get(`presence:last:${userId}`)) as PresenceStatus | null) ?? "offline";
}
async function setLastKnownPresence(userId: string, status: PresenceStatus): Promise<void> {
  await kvRedis.set(`presence:last:${userId}`, status, "EX", 86400);
}

// Fan-out helpers: 1 Redis call instead of N (one per connection)
async function fanOutToGuild(communityId: string, payload: string): Promise<void> {
  const raw = await kvRedis.smembers(`presence:guild:${communityId}`);
  for (const uid of raw) {
    const conns = userConnections.get(normUserId(uid));
    if (!conns) continue;
    for (const connId of conns) {
      const conn = connections.get(connId);
      if (conn) enqueueSend(conn.ws, payload, "guild");
    }
  }
}
async function fanOutToChannel(channelId: string, payload: string): Promise<void> {
  const raw = await kvRedis.smembers(`presence:channel:${channelId}`);
  for (const uid of raw) {
    const conns = userConnections.get(normUserId(uid));
    if (!conns) continue;
    for (const connId of conns) {
      const conn = connections.get(connId);
      if (conn) enqueueSend(conn.ws, payload, "channel");
    }
  }
}

async function getAwayMessage(userId: string): Promise<string | undefined> {
  return (await kvRedis.get(`presence:away:${userId}`)) ?? undefined;
}

async function buildPresencePayload(userId: string): Promise<{ status: PresenceStatus; awayMessage?: string }> {
  const status = await computePresence(kvRedis, userId, liveInstanceIds);
  const awayMessage = status === "away" ? await getAwayMessage(userId) : undefined;
  return { status, awayMessage };
}

// Helper to update presence and broadcast if it changed, used after connection events and activity updates
async function updateAndBroadcast(userId: string, prevStatus: PresenceStatus): Promise<void> {
  const { status: newStatus, awayMessage } = await buildPresencePayload(userId);
  if (newStatus !== prevStatus) {
    logger.info({ userId, from: prevStatus, to: newStatus }, "presence changed");
    await broadcastPresenceChange(kvRedis, redis, userId, newStatus, awayMessage);
    await setLastKnownPresence(userId, newStatus);
  }
}

// Shared DM fanout: invoked by both pubsub handler and the /internal/deliver-dm
// endpoint. Local-conn fanout only — does not republish. Callers that want
// cluster-wide reach publish via redis AND/OR POST to every instance.
type DmFanoutSource = "pubsub" | "direct" | "shard";
function fanOutDmEventLocal(
  event: { type: string; participantIds?: string[]; conversationId?: unknown; message?: unknown; publishedAt?: unknown; [k: string]: unknown },
  source: DmFanoutSource
): { delivered: number; localMiss: number; totalTargets: number } {
  const publishedAt = typeof event.publishedAt === "number" ? event.publishedAt : undefined;
  const targetUserIds = new Set((event.participantIds ?? []).map(normUserId));
  const dmMsg = event.type === "dm:message:create" && event.message && typeof event.message === "object"
    ? event.message as { messageId?: string; authorId?: string; timeuuid?: string; createdAt?: string }
    : null;

  const outgoing = JSON.stringify({ ...event, source });

  let dmSentCount = 0;
  let dmNotConnectedCount = 0;
  const authorIdNorm = dmMsg?.authorId ? normUserId(dmMsg.authorId) : null;

  for (const targetUid of targetUserIds) {
    const conns = userConnections.get(targetUid);
    if (!conns || conns.size === 0) {
      if (event.type === "dm:message:create") {
        const isSelfEcho = authorIdNorm !== null && targetUid === authorIdNorm;
        if (isSelfEcho) continue;
        dmNotConnectedCount++;
      }
      continue;
    }
    logger.info(
      {
        source,
        eventType: event.type,
        targetUid,
        localConnectionCount: conns.size,
        chosenConnIds: [...conns],
        conversationId: event.conversationId,
        messageId: dmMsg?.messageId,
        publishedAt,
        instanceId,
        workerId: workerLabel,
      },
      "dm fanout: local recipient routing decision"
    );
    for (const connId of conns) {
      const conn = connections.get(connId);
      if (conn) {
        enqueueSend(conn.ws, outgoing, "dm_event", {
          userId: targetUid,
          connId,
          conversationId: event.conversationId as string | undefined,
          messageId: dmMsg?.messageId,
        }, true);
        if (event.type === "dm:message:create") {
          dmSentCount++;
          const sentAtMs = Date.now();
          logger.info({
            targetUid,
            connId,
            conversationId: event.conversationId,
            messageId: dmMsg?.messageId,
            authorId: dmMsg?.authorId,
            source,
            sentAt: new Date(sentAtMs).toISOString(),
            publishedAt,
            totalLatencyMs: publishedAt !== undefined ? sentAtMs - publishedAt : undefined,
          }, "dm fanout: sent to client");
        }
      }
    }
  }

  if (event.type === "dm:message:create") {
    logger.info(
      {
        source,
        conversationId: event.conversationId,
        messageId: dmMsg?.messageId,
        delivered: dmSentCount,
        localMiss: dmNotConnectedCount,
        totalTargets: targetUserIds.size,
        instanceId,
        workerId: workerLabel,
      },
      "dm fanout: local delivery summary"
    );
  }

  return { delivered: dmSentCount, localMiss: dmNotConnectedCount, totalTargets: targetUserIds.size };
}

// Must match USER_FEED_SHARD_COUNT in dms service
const USER_FEED_SHARD_COUNT = 20;
const dmShardChannels = Array.from({ length: USER_FEED_SHARD_COUNT }, (_, i) => `dm:userfeed:${i}`);

// Targeted per-user fanout used by the shard pubsub path. Delivers to exactly
// one user's connections; dedup prevents double-send with direct HTTP path.
function deliverDmEventToUser(
  targetUserId: string,
  event: { type: string; conversationId?: unknown; message?: unknown; publishedAt?: unknown; [k: string]: unknown },
  source: DmFanoutSource
): void {
  const normId = normUserId(targetUserId);
  const dmMsg = event.type === "dm:message:create" && event.message && typeof event.message === "object"
    ? event.message as { messageId?: string; authorId?: string; timeuuid?: string }
    : null;
  const conns = userConnections.get(normId);
  if (!conns || conns.size === 0) {
    logger.info(
      {
        source,
        targetUserId: normId,
        localConnectionCount: 0,
        conversationId: event.conversationId,
        messageId: dmMsg?.messageId,
        publishedAt: event.publishedAt,
        instanceId,
        workerId: workerLabel,
      },
      "dm shard: no local connections for target"
    );
    return;
  }

  const outgoing = JSON.stringify({ ...event, source });
  logger.info(
    {
      source,
      targetUserId: normId,
      localConnectionCount: conns.size,
      chosenConnIds: [...conns],
      conversationId: event.conversationId,
      messageId: dmMsg?.messageId,
      publishedAt: event.publishedAt,
      instanceId,
      workerId: workerLabel,
    },
    "dm shard: recipient routing decision"
  );

  for (const connId of conns) {
    const conn = connections.get(connId);
    if (!conn) continue;
    enqueueSend(conn.ws, outgoing, "dm_shard", { userId: normId, connId, messageId: dmMsg?.messageId }, true);
  }
}

// Instance registry — dms service reads this hash to discover realtime instances
// for direct HTTP fanout. Refreshed periodically so stale instances age out.
const INSTANCE_REGISTRY_KEY = "realtime:instances";
const INSTANCE_REGISTRY_TTL_SEC = 30;
const INSTANCE_REGISTRY_REFRESH_MS = 10_000;
const STALE_REAPER_INTERVAL_MS = 30_000;

// In-memory cache of currently-live realtime instance ids (own + peers from registry).
// Refreshed alongside registerInstance(). Used by hasRegisteredConnections + the reaper
// so we never trust hash fields whose owning instance no longer exists.
let liveInstanceIds: Set<string> = new Set([instanceId]);

async function refreshLiveInstanceIds(): Promise<void> {
  try {
    const registry = await kvRedis.hgetall(INSTANCE_REGISTRY_KEY);
    liveInstanceIds = new Set([instanceId, ...Object.keys(registry)]);
  } catch (err) {
    logger.warn({ err }, "live instance refresh failed");
  }
}

async function registerInstance(): Promise<void> {
  if (!env.REALTIME_INTERNAL_URL) return;
  await kvRedis.hset(INSTANCE_REGISTRY_KEY, instanceId, env.REALTIME_INTERNAL_URL);
  await kvRedis.expire(INSTANCE_REGISTRY_KEY, INSTANCE_REGISTRY_TTL_SEC);
  await refreshLiveInstanceIds();
}

async function unregisterInstance(): Promise<void> {
  if (!env.REALTIME_INTERNAL_URL) return;
  try {
    await kvRedis.hdel(INSTANCE_REGISTRY_KEY, instanceId);
  } catch {
    // best effort on shutdown
  }
}

// Reap presence:conns hash fields whose owning instanceId is no longer live.
// Without this, every realtime restart leaves orphaned fields that cause
// hasRegisteredConnections to lie ("user is online" when actually offline),
// silently dropping DM fanout with no warning.
async function reapStaleConnFields(): Promise<void> {
  await refreshLiveInstanceIds();
  let cursor = "0";
  let reaped = 0;
  do {
    const [next, keys] = await kvRedis.scan(cursor, "MATCH", "presence:conns:*", "COUNT", 200);
    cursor = next;
    if (keys.length === 0) continue;
    const pipeline = kvRedis.pipeline();
    for (const key of keys) pipeline.hkeys(key);
    const results = await pipeline.exec();
    const delPipeline = kvRedis.pipeline();
    let hasDeletes = false;
    results?.forEach((result, i) => {
      const fields = (result?.[1] as string[]) ?? [];
      const stale = fields.filter((f) => !liveInstanceIds.has(f.split(":")[0]));
      if (stale.length > 0) {
        delPipeline.hdel(keys[i], ...stale);
        reaped += stale.length;
        hasDeletes = true;
      }
    });
    if (hasDeletes) await delPipeline.exec();
  } while (cursor !== "0");
  if (reaped > 0) logger.info({ reaped, liveInstances: [...liveInstanceIds] }, "reaped stale presence:conns fields");
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "realtime-service", connections: connections.size });
});

// Internal endpoint — only called by other services, not exposed publicly
app.get("/internal/presence/:userId", async (req, res) => {
  const { userId } = req.params;
  const { status, awayMessage } = await buildPresencePayload(userId);
  res.json({ userId, status, awayMessage });
});

// Direct DM delivery path — dms service POSTs here in parallel to redis pubsub.
// Redis pubsub remains the durability backstop; direct path cuts cross-VM
// latency variance for the hot case where the target is already connected.
// Client dedupes by messageId so overlap with pubsub is harmless.
app.post("/internal/deliver-dm", (req, res) => {
  const body = req.body as { event?: unknown } | undefined;
  const event = body?.event as
    | { type: string; participantIds?: string[]; publishedAt?: unknown; [key: string]: unknown }
    | undefined;
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    res.status(400).json({ error: "event required" });
    return;
  }
  if (event.type === "dm:message:create") {
    const publishedAt = typeof event.publishedAt === "number" ? event.publishedAt : undefined;
    const dmMsg = event.message && typeof event.message === "object"
      ? (event.message as { messageId?: string })
      : null;
    logger.info({
      conversationId: event.conversationId,
      messageId: dmMsg?.messageId,
      publishedAt,
      transitMs: publishedAt !== undefined ? Date.now() - publishedAt : undefined,
      path: "direct",
    }, "dm:message:create direct-HTTP received");
  }
  const result = fanOutDmEventLocal(event, "direct");
  res.json(result);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Server-side ping/pong heartbeat. Keeps idle WS alive through NAT/proxy timeouts
// and detects half-open TCP so we can terminate and clean up.
const HEARTBEAT_MS = 25_000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const w = ws as WebSocket & { isAlive?: boolean };
    if (w.isAlive === false) {
      ws.terminate();
      continue;
    }
    w.isAlive = false;
    try {
      ws.ping();
    } catch {
      // socket closed mid-iteration, ignore
    }
  }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

// Initial websocket connection
wss.on("connection", async (ws, req) => {
  // Authenticate via session_token cookie
  const cookieHeader = req.headers.cookie ?? "";
  const cookies = parseCookie(cookieHeader);
  const token = cookies["session_token"];

  if (!token) {
    ws.close(4401, "No session token");
    return;
  }

  const userId = await kvRedis.get(`session:${token}`);

  if (!userId) {
    ws.close(4401, "Invalid or expired session");
    return;
  }

  const connId = randomUUID();
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  });
  // Get the user's current presence before registering the new connection
  const prevStatus = await computePresence(kvRedis, userId, liveInstanceIds);

  connections.set(connId, { ws, userId, recentMessageIds: new Set(), outboundQueue: [], draining: false, createdAtMs: Date.now() });
  wsConnId.set(ws, connId);
  const normId = normUserId(userId);
  if (!userConnections.has(normId)) userConnections.set(normId, new Set());
  userConnections.get(normId)!.add(connId);
  logger.info(
    {
      userId,
      connId,
      localConnectionCount: userConnections.get(normId)?.size ?? 0,
      totalConnections: connections.size,
      instanceId,
      workerId: workerLabel,
    },
    "realtime connection added to local maps"
  );

  // Register close/error handlers immediately after adding to the map so that if the socket
  // closes during any subsequent await the cleanup always runs and the connection is not leaked.
  ws.on("close", async (closeCode: number) => {
    // Remove from local maps synchronously before any await so fanout never
    // finds this closed socket during the async gap.
    const removal = removeLocalConnection(connId, ws, "close_event", { closeCode });
    logger.info({ userId, connId, closeCode, total: connections.size }, "client disconnected");
    const prev = await computePresence(kvRedis, userId, liveInstanceIds);
    await removeConnection(kvRedis, userId, connId, instanceId);
    const stillConnectedElsewhere = await hasRegisteredConnections(kvRedis, userId, liveInstanceIds);
    // Broadcast BEFORE unsubscribing — targets are looked up from context sets,
    // which must still be in Redis when broadcastPresenceChange runs.
    // Try-catch so a Redis hiccup here does not skip the offline marker write.
    try {
      await updateAndBroadcast(userId, prev);
    } catch (err) {
      logger.warn({ err, userId }, "presence broadcast failed on disconnect");
    }
    if (!stillConnectedElsewhere) {
      await unsubscribeUser(kvRedis, userId);
      // Store disconnect timestamp + close code so reconnect can replay from
      // the right window. 2-hour TTL matches pending-queue TTL.
      await kvRedis.set(
        `presence:offline:${userId}`,
        JSON.stringify({ disconnectedAt: Date.now(), closeCode }),
        "EX",
        7200
      );
      logger.info(
        {
          userId,
          connId,
          closeCode,
          removalAgeMs: removal.ageMs,
          instanceId,
          workerId: workerLabel,
        },
        "presence offline marker written"
      );
    }
  });

  ws.on("error", (err) => {
    logger.error({ err, connId }, "websocket error");
  });

  await registerConnection(kvRedis, userId, connId, instanceId);
  await subscribeUser(kvRedis, userId);

  logger.info({ userId, connId, total: connections.size }, "client connected");
  await updateAndBroadcast(userId, prevStatus);
  const { status: currentStatus, awayMessage: currentAwayMessage } = await buildPresencePayload(userId);
  await setLastKnownPresence(userId, currentStatus);

  // Reconcile missed DMs after reconnect. First drain the dm:pending queue
  // populated by dms on publish (covers the "ws not open, readyState:3" race
  // where live fanout tried to send to a socket tearing down), then fall
  // back to Cassandra + read-state cursors for anything older than the
  // queue's TTL or outside its capped window.
  setImmediate(() => {
    void (async () => {
      await drainPendingDmHints(ws, userId);
      if (ws.readyState !== WebSocket.OPEN) return;
      // Atomic test-and-clear: only the first reconnecting tab after a true
      // offline period runs catchup. Concurrent reconnects find marker gone
      // and skip the Cassandra scan. drainPendingDmHints above
      // (Redis-backed, 2h TTL) remains the durable backstop in all cases.
      const offlineRaw = await kvRedis.getdel(`presence:offline:${userId}`);
      if (offlineRaw) {
        let disconnectedAt = Date.now();
        let closeCode = 1006;
        try {
          const parsed = JSON.parse(offlineRaw) as { disconnectedAt?: number; closeCode?: number };
          if (typeof parsed.disconnectedAt === "number") disconnectedAt = parsed.disconnectedAt;
          if (typeof parsed.closeCode === "number") closeCode = parsed.closeCode;
        } catch { /* legacy "1" value — use defaults */ }
        await replayMissedDmHintsFromDisconnect(ws, userId, disconnectedAt, closeCode);
      }
    })();
  });

  // Send current presence snapshot to the newly connected client
  setImmediate(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Send own presence immediately
    enqueueSend(ws, JSON.stringify({ type: "presence_update", userId, status: currentStatus, awayMessage: currentAwayMessage }), "presence_init");

    // Get all related users and send their presence. buildPresencePayload uses
    // Redis (cross-instance aware) — do not pre-filter by local userConnections
    // or users on other instances are silently excluded from the snapshot.
    const relatedUserIds = await getPresenceTargets(kvRedis, userId);
    const relatedExcludingSelf = relatedUserIds.filter((id) => normUserId(id) !== normUserId(userId));

    const presencePayloads = await Promise.all(
      relatedExcludingSelf.map(async (relatedUserId) => {
        const { status, awayMessage } = await buildPresencePayload(relatedUserId);
        return { userId: relatedUserId, status, awayMessage };
      })
    );
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const payload of presencePayloads) {
      enqueueSend(ws, JSON.stringify({ type: "presence_update", ...payload }), "presence_snapshot");
    }
  });

  // Handle incoming messages for activity updates through timeout and manual away/back status changes
  ws.on("message", async (data) => {
    let msg: { type: string; message?: string };

    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "ping") {
      await updateActivity(kvRedis, userId, connId, instanceId);
      return;
    }

    const prev = await computePresence(kvRedis, userId, liveInstanceIds);

    if (msg.type === "subscribe_channel") {
      const channelId = (msg as { channelId?: string }).channelId;
      if (typeof channelId === "string" && channelId.length > 0) {
        await subscribeChannel(kvRedis, channelId, userId);
        logger.info({ userId, connId, channelId }, "client subscribed to channel");
      }
    } else if (msg.type === "away") {
      // Manually set away status with an optional message that other users can see
      await setAway(kvRedis, userId, (msg.message as string) ?? "");
      const { status: awayStatus, awayMessage: awayMsg } = await buildPresencePayload(userId);
      await setLastKnownPresence(userId, awayStatus);
      await broadcastPresenceChange(kvRedis, redis, userId, awayStatus, awayMsg);
      return;
    } else if (msg.type === "back") {
      // Manually remove the away status from the redis. Goes back to the previous status before away
      await clearAway(kvRedis, userId);
    }

    // Ultimately, do a broadcast if the presence changed from prev to a new status due to the message
    // OUTSIDE of the msg type specific handling above
    await updateAndBroadcast(userId, prev);
  });

});

// Every 30s check all connected users for idle transitions
// Worst case the ui will update 90s after the user goes idle
// The truth lives on the server and the ui only learns about it when this fires 30s after that 60s idle timeout
setInterval(async () => {
  const checkedUsers = new Set<string>();
  for (const { userId } of connections.values()) {
    if (checkedUsers.has(userId)) continue;
    checkedUsers.add(userId);
    const prev = await getLastKnownPresence(userId);
    const { status: newStatus, awayMessage } = await buildPresencePayload(userId);
    await setLastKnownPresence(userId, newStatus);
    if (newStatus !== prev) {
      logger.info({ userId, from: prev, to: newStatus }, "presence changed");
      await broadcastPresenceChange(kvRedis, redis, userId, newStatus, awayMessage);
    }
  }
}, 30_000);

// Subscribe to per-user shard channels (replaces single dm:events channel),
// plus community/channel/presence broadcast channels.
redisSub.subscribe(...dmShardChannels, "community:events", "channel:events", PRESENCE_BROADCAST_CHANNEL, (err) => {
  if (err) logger.error({ err }, "pubsub subscribe failed");
  else logger.info({ shards: USER_FEED_SHARD_COUNT }, "subscribed to pubsub channels: dm:userfeed:*, community:events, channel:events, presence:broadcast");
});

redisSub.on("message", (channel, message) => {
  if (channel === PRESENCE_BROADCAST_CHANNEL) {
    let msg: PresenceBroadcastMessage;
    try { msg = JSON.parse(message); } catch { return; }
    const payload = JSON.stringify({ type: "presence_update", userId: msg.userId, status: msg.status, awayMessage: msg.awayMessage });
    for (const targetUid of (msg.targets ?? []).map(normUserId)) {
      const conns = userConnections.get(targetUid);
      if (!conns) continue;
      for (const connId of conns) {
        const conn = connections.get(connId);
        if (conn) enqueueSend(conn.ws, payload, "presence_broadcast");
      }
    }
    return;
  }
  if (channel === "community:events") {
    let event: { type: string; communityId?: string; userId?: string; [key: string]: unknown };
    try { event = JSON.parse(message); } catch { return; }

    if (event.type === "community:member:join") {
      const communityId = event.communityId as string;
      const userId = event.userId as string;
      void (async () => {
        // Update Redis subscription sets
        await subscribeCommunity(kvRedis, communityId, userId);
        await subscribeAllChannelsForUserInCommunity(kvRedis, userId, communityId);
        // Forward event to all connected members of this community
        await fanOutToGuild(communityId, JSON.stringify(event));
        // Broadcast the new member's presence to all related users (shard-safe via Redis pub/sub)
        const { status: newMemberStatus, awayMessage: newMemberAway } = await buildPresencePayload(userId);
        await broadcastPresenceChange(kvRedis, redis, userId, newMemberStatus, newMemberAway);
        // Send the new member their presence snapshot of existing connected members
        const newMemberConns = userConnections.get(normUserId(userId));
        for (const connId of newMemberConns ?? []) {
          const conn = connections.get(connId);
          if (!conn) continue;
          const { ws } = conn;
          const relatedIds = await getPresenceTargets(kvRedis, userId);
          const relatedExcludingSelf = relatedIds.filter((id) => normUserId(id) !== normUserId(userId));
          const payloads = await Promise.all(
            relatedExcludingSelf.map(async (rid) => {
              const { status, awayMessage } = await buildPresencePayload(rid);
              return { userId: rid, status, awayMessage };
            })
          );
          for (const p of payloads) {
            enqueueSend(ws, JSON.stringify({ type: "presence_update", ...p }), "join_snapshot");
          }
        }
      })();
    }

    if (event.type === "community:channel:create") {
      const communityId = event.communityId as string;
      const ch = event.channel as { id?: string; is_private?: boolean } | undefined;
      const channelId = ch?.id;
      if (channelId && ch?.is_private !== true) {
        void subscribeAllMembersForChannel(kvRedis, channelId);
      }
      void fanOutToGuild(communityId, JSON.stringify(event));
    }

    if (event.type === "community:channel:delete") {
      const communityId = event.communityId as string;
      void fanOutToGuild(communityId, JSON.stringify(event));
    }

    if (event.type === "community:member:leave") {
      const communityId = event.communityId as string;
      const userId = event.userId as string;
      void (async () => {
        await unsubscribeCommunity(kvRedis, communityId, userId);
        await fanOutToGuild(communityId, JSON.stringify(event));
      })();
    }

    if (event.type === "community:channel:member:add") {
      const channelId = event.channelId as string;
      const userId = event.userId as string;
      const payload = JSON.stringify(event);
      void (async () => {
        await subscribeChannel(kvRedis, channelId, userId);
        const conns = userConnections.get(normUserId(userId));
        if (conns) for (const connId of conns) {
          const conn = connections.get(connId);
          if (conn) enqueueSend(conn.ws, payload, "ch_member_add");
        }
      })();
    }

    if (event.type === "community:channel:member:remove") {
      const channelId = event.channelId as string;
      const userId = event.userId as string;
      const payload = JSON.stringify(event);
      void (async () => {
        await unsubscribeChannel(kvRedis, channelId, userId);
        const conns = userConnections.get(normUserId(userId));
        if (conns) for (const connId of conns) {
          const conn = connections.get(connId);
          if (conn) enqueueSend(conn.ws, payload, "ch_member_remove");
        }
      })();
    }
    return;
  }

  if (channel === "channel:events") {
    let event: { type: string; channelId?: string; communityId?: string; [key: string]: unknown };
    try { event = JSON.parse(message); } catch { return; }

    const channelId = event.channelId as string;
    if (!channelId) return;

    const chMsg = event.message as { messageId?: string; authorId?: string; timeuuid?: string; createdAt?: string } | undefined;

    if (event.type === "channel:message:create") {
      logger.info({
        channelId,
        messageId: chMsg?.messageId,
        authorId: chMsg?.authorId,
        timeuuid: chMsg?.timeuuid,
        createdAt: chMsg?.createdAt,
        receivedAt: new Date().toISOString(),
      }, "channel:message:create received from redis");

      void (async () => {
        const payload = JSON.stringify(event);
        const raw = await kvRedis.smembers(`presence:channel:${channelId}`);
        let sentCount = 0;
        let notConnectedCount = 0;
        for (const uid of raw) {
          const conns = userConnections.get(normUserId(uid));
          if (!conns || conns.size === 0) {
            notConnectedCount++;
            logger.info({
              targetUid: uid,
              channelId,
              messageId: chMsg?.messageId,
              authorId: chMsg?.authorId,
            }, "channel fanout: target not connected on this instance");
            continue;
          }
          for (const connId of conns) {
            const conn = connections.get(connId);
            if (conn) {
              enqueueSend(conn.ws, payload, "channel", undefined, true);
              sentCount++;
              logger.info({
                targetUid: uid,
                connId,
                channelId,
                messageId: chMsg?.messageId,
                authorId: chMsg?.authorId,
                sentAt: new Date().toISOString(),
              }, "channel fanout: sent to client");
            }
          }
        }
        logger.info({
          channelId,
          messageId: chMsg?.messageId,
          authorId: chMsg?.authorId,
          sentCount,
          notConnectedCount,
          totalSubscribed: raw.length,
        }, "channel:message:create fanout complete");
      })();
    } else {
      logger.info({
        eventType: event.type,
        channelId,
        messageId: chMsg?.messageId,
        receivedAt: new Date().toISOString(),
      }, "channel event received, fanning out");
      void fanOutToChannel(channelId, JSON.stringify(event));
    }
    return;
  }

  // Shard channel: each message targets exactly one user.
  if (channel.startsWith("dm:userfeed:")) {
    let envelope: { targetUserId?: string; event?: { type: string; participantIds?: string[]; [key: string]: unknown } };
    try { envelope = JSON.parse(message); } catch { return; }
    const { targetUserId, event } = envelope;
    if (!targetUserId || !event?.type) return;

    deliverDmEventToUser(targetUserId, event, "shard");

    // Side effects — run once per target user so each user handles their own state.
    if (event.type === "dm:conversation:create") {
      const conversationId = event.conversationId as string;
      void (async () => {
        await subscribeDm(kvRedis, conversationId, [targetUserId]);
        // Send each other participant's current presence to this user's connections.
        const conns = userConnections.get(normUserId(targetUserId));
        if (!conns) return;
        const others = (event.participantIds ?? []).filter(p => normUserId(p) !== normUserId(targetUserId));
        for (const otherId of others) {
          const { status, awayMessage } = await buildPresencePayload(otherId);
          const presencePayload = JSON.stringify({ type: "presence_update", userId: otherId, status, awayMessage });
          for (const connId of conns) {
            const conn = connections.get(connId);
            if (conn) enqueueSend(conn.ws, presencePayload, "dm_conv_create_presence");
          }
        }
      })();
    }

    if (event.type === "dm:participant:leave") {
      const leavingUserId = (event as { userId?: string }).userId;
      if (leavingUserId && normUserId(leavingUserId) === normUserId(targetUserId)) {
        void unsubscribeDm(kvRedis, event.conversationId as string, leavingUserId);
      }
    }
    return;
  }
});

initDb()
  .then(() => {
    return initCassandra();
  })
  .then(() => {
    server.listen(Number(env.PORT), () => {
      logger.info({ port: env.PORT, internalUrl: env.REALTIME_INTERNAL_URL || "(not set)" }, "realtime service running");
    });
    // keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
    // Prevents ERR_INCOMPLETE_CHUNKED_ENCODING on /internal/* HTTP routes when nginx reuses a socket Node just closed.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    if (shouldRegisterInstance) {
      void registerInstance().catch((err) =>
        logger.warn({ err }, "instance registry: initial registration failed")
      );
      setInterval(() => {
        void registerInstance().catch((err) =>
          logger.warn({ err }, "instance registry: refresh failed")
        );
      }, INSTANCE_REGISTRY_REFRESH_MS);
    }
    void reapStaleConnFields().catch((err) => logger.warn({ err }, "initial stale reap failed"));
    setInterval(() => {
      void reapStaleConnFields().catch((err) => logger.warn({ err }, "stale reap failed"));
    }, STALE_REAPER_INTERVAL_MS);
  })
  .catch((err) => {
    logger.error({ err }, "failed to initialize DB");
    process.exit(1);
  });

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  await unregisterInstance();
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
