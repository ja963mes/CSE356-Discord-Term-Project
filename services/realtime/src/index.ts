import http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookie } from "cookie";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { types as cassandraTypes } from "cassandra-driver";
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
import { getLastReadTimeuuidForDm, getLatestDmTimeuuid, initCassandra, listDmMessagesNewerThan } from "./cassandra";

// Unique ID for this instance — used to namespace presence:conns fields
// so multiple instances don't stomp on each other's connection data at startup
const instanceId = randomUUID();
logger.info({ instanceId }, "startup");

const redis = new Redis(env.REDIS_URL);
redis.on("connect", async () => {
  logger.info("redis connected");
  // Clear only this instance's stale connection fields from previous runs.
  // Other instances' fields are left intact so their presence tracking is unaffected.
  const keys = await redis.keys("presence:conns:*");
  let cleared = 0;
  for (const key of keys) {
    const fields = await redis.hkeys(key);
    const stale = fields.filter((f) => f.startsWith(`${instanceId}:`));
    if (stale.length > 0) {
      await redis.hdel(key, ...stale);
      cleared += stale.length;
    }
  }
  if (cleared > 0) logger.info({ cleared, instanceId }, "cleared stale presence fields");
});
redis.on("error", (err) => logger.error({ err }, "redis error"));

// Dedicated Redis client for pub/sub (ioredis requires a separate connection for subscriptions)
const redisSub = new Redis(env.REDIS_URL);
redisSub.on("error", (err) => logger.error({ err }, "redis sub error"));

// Track active connections: connId -> { ws, userId }
const connections = new Map<string, { ws: WebSocket; userId: string }>();
// Reverse index: normalizedUserId -> Set<connId> for O(1) fanout lookup
const userConnections = new Map<string, Set<string>>();

/** Normalize user ids for Set membership (Postgres JSON vs session can differ in UUID case). */
function normUserId(id: string): string {
  return id.trim().toLowerCase();
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
    const result = await redis.multi().lrange(key, 0, -1).del(key).exec();
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
    let hint: { type?: string; conversationId?: string; messageId?: string; authorId?: string; timeuuid?: string };
    try {
      hint = JSON.parse(raw);
    } catch {
      continue;
    }
    if (hint.type !== "dm:new_message" || !hint.messageId || !hint.authorId) continue;
    safeSend(
      ws,
      JSON.stringify({ ...hint, source: "pending" }),
      "dm_pending",
      { userId, conversationId: hint.conversationId, messageId: hint.messageId }
    );
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

async function catchUpOneConversation(ws: WebSocket, userId: string, conversationId: string): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;

  let lastRead: string | null = null;
  let latest: string | null = null;
  try {
    [lastRead, latest] = await Promise.all([
      withRetry("getLastReadTimeuuidForDm", { userId, conversationId }, () =>
        getLastReadTimeuuidForDm(userId, conversationId)
      ),
      withRetry("getLatestDmTimeuuid", { userId, conversationId }, () =>
        getLatestDmTimeuuid(conversationId)
      ),
    ]);
  } catch (err) {
    logger.warn({ err, userId, conversationId }, "dm catch-up failed to read cursor");
    return;
  }

  if (!latest) return;
  if (lastRead) {
    try {
      const latestTuuid = cassandraTypes.TimeUuid.fromString(latest);
      const lastReadTuuid = cassandraTypes.TimeUuid.fromString(lastRead);
      if (latestTuuid.getBuffer().compare(lastReadTuuid.getBuffer()) <= 0) {
        return;
      }
    } catch (err) {
      logger.warn({ err, userId, conversationId }, "dm catch-up timeuuid compare failed");
    }
  }

  let rows;
  try {
    rows = await withRetry("listDmMessagesNewerThan", { userId, conversationId }, () =>
      listDmMessagesNewerThan({
        conversationId,
        afterTimeuuid: lastRead,
        limit: 25,
      })
    );
  } catch (err) {
    logger.warn({ err, userId, conversationId }, "dm catch-up failed to list messages");
    return;
  }

  // Cassandra rows come back newest-first; replay hints oldest-first.
  for (const row of [...rows].reverse()) {
    if (ws.readyState !== WebSocket.OPEN) return;
    safeSend(
      ws,
      JSON.stringify({
        type: "dm:new_message",
        conversationId,
        messageId: row.messageId,
        authorId: row.authorId,
        timeuuid: row.timeuuid,
        source: "catchup",
      }),
      "dm_catchup",
      { userId, conversationId, messageId: row.messageId }
    );
  }
}

async function replayMissedDmHints(ws: WebSocket, userId: string): Promise<void> {
  const MAX_CONVERSATIONS = 50;
  const CONCURRENCY = 5;

  let conversationIds: string[];
  try {
    conversationIds = await listUserDmConversationIds(userId);
  } catch (err) {
    logger.warn({ err, userId }, "dm catch-up failed to list conversations");
    return;
  }

  const queue = conversationIds.slice(0, MAX_CONVERSATIONS);
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < queue.length) {
      const i = idx++;
      if (ws.readyState !== WebSocket.OPEN) return;
      await catchUpOneConversation(ws, userId, queue[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

function safeSend(
  ws: WebSocket,
  payload: string,
  label: string,
  ctx?: { userId?: string; connId?: string; conversationId?: string; messageId?: string }
): void {
  if (ws.readyState !== WebSocket.OPEN) {
    if (label === "dm_event") {
      logger.warn({ label, readyState: ws.readyState, ...ctx }, "ws not open, dropping send");
    }
    return;
  }
  try {
    ws.send(payload);
  } catch (err) {
    logger.warn({ err, label, ...ctx }, "ws fanout send failed");
  }
}

// Last known presence stored in Redis so multiple instances agree on state
async function getLastKnownPresence(userId: string): Promise<PresenceStatus> {
  return ((await redis.get(`presence:last:${userId}`)) as PresenceStatus | null) ?? "offline";
}
async function setLastKnownPresence(userId: string, status: PresenceStatus): Promise<void> {
  await redis.set(`presence:last:${userId}`, status, "EX", 86400);
}

// Fan-out helpers: 1 Redis call instead of N (one per connection)
async function fanOutToGuild(communityId: string, payload: string): Promise<void> {
  const raw = await redis.smembers(`presence:guild:${communityId}`);
  for (const uid of raw) {
    const conns = userConnections.get(normUserId(uid));
    if (!conns) continue;
    for (const connId of conns) {
      const conn = connections.get(connId);
      if (conn) safeSend(conn.ws, payload, "guild");
    }
  }
}
async function fanOutToChannel(channelId: string, payload: string): Promise<void> {
  const raw = await redis.smembers(`presence:channel:${channelId}`);
  for (const uid of raw) {
    const conns = userConnections.get(normUserId(uid));
    if (!conns) continue;
    for (const connId of conns) {
      const conn = connections.get(connId);
      if (conn) safeSend(conn.ws, payload, "channel");
    }
  }
}

async function getAwayMessage(userId: string): Promise<string | undefined> {
  return (await redis.get(`presence:away:${userId}`)) ?? undefined;
}

async function buildPresencePayload(userId: string): Promise<{ status: PresenceStatus; awayMessage?: string }> {
  const status = await computePresence(redis, userId);
  const awayMessage = status === "away" ? await getAwayMessage(userId) : undefined;
  return { status, awayMessage };
}

// Helper to update presence and broadcast if it changed, used after connection events and activity updates
async function updateAndBroadcast(userId: string, prevStatus: PresenceStatus): Promise<void> {
  const { status: newStatus, awayMessage } = await buildPresencePayload(userId);
  if (newStatus !== prevStatus) {
    logger.info({ userId, from: prevStatus, to: newStatus }, "presence changed");
    await broadcastPresenceChange(redis, userId, newStatus, awayMessage);
    await setLastKnownPresence(userId, newStatus);
  }
}

// Shared DM fanout: invoked by both pubsub handler and the /internal/deliver-dm
// endpoint. Local-conn fanout only — does not republish. Callers that want
// cluster-wide reach publish via redis AND/OR POST to every instance.
type DmFanoutSource = "pubsub" | "direct";
function fanOutDmEventLocal(
  event: { type: string; participantIds?: string[]; conversationId?: unknown; message?: unknown; [k: string]: unknown },
  source: DmFanoutSource
): { delivered: number; localMiss: number; totalTargets: number } {
  const targetUserIds = new Set((event.participantIds ?? []).map(normUserId));
  const dmMsg = event.type === "dm:message:create" && event.message && typeof event.message === "object"
    ? event.message as { messageId?: string; authorId?: string; timeuuid?: string; createdAt?: string }
    : null;

  const outgoing =
    event.type === "dm:message:create"
      ? JSON.stringify({
          type: "dm:new_message",
          conversationId: event.conversationId,
          messageId: dmMsg?.messageId,
          authorId: dmMsg?.authorId,
          timeuuid: dmMsg?.timeuuid,
          source,
        })
      : JSON.stringify(event);

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
        // Only warn from pubsub path; the direct path is per-instance targeted
        // so a miss here is expected for instances that don't hold that user.
        if (source === "pubsub") {
          void (async () => {
            try {
              const elsewhere = await hasRegisteredConnections(redis, targetUid);
              if (elsewhere) return;
              logger.warn({
                targetUid,
                conversationId: event.conversationId,
                messageId: dmMsg?.messageId,
                authorId: dmMsg?.authorId,
                offline: true,
              }, "dm fanout: target offline cluster-wide");
            } catch (err) {
              logger.warn({
                err,
                targetUid,
                conversationId: event.conversationId,
                messageId: dmMsg?.messageId,
                authorId: dmMsg?.authorId,
              }, "dm fanout: presence check failed");
            }
          })();
        }
      }
      continue;
    }
    for (const connId of conns) {
      const conn = connections.get(connId);
      if (conn) {
        safeSend(conn.ws, outgoing, "dm_event", {
          userId: targetUid,
          connId,
          conversationId: event.conversationId as string | undefined,
          messageId: dmMsg?.messageId,
        });
        if (event.type === "dm:message:create") {
          dmSentCount++;
          logger.info({
            targetUid,
            connId,
            conversationId: event.conversationId,
            messageId: dmMsg?.messageId,
            authorId: dmMsg?.authorId,
            source,
            sentAt: new Date().toISOString(),
          }, "dm fanout: sent to client");
        }
      }
    }
  }

  return { delivered: dmSentCount, localMiss: dmNotConnectedCount, totalTargets: targetUserIds.size };
}

// Instance registry — dms service reads this hash to discover realtime instances
// for direct HTTP fanout. Refreshed periodically so stale instances age out.
const INSTANCE_REGISTRY_KEY = "realtime:instances";
const INSTANCE_REGISTRY_TTL_SEC = 30;
const INSTANCE_REGISTRY_REFRESH_MS = 10_000;

async function registerInstance(): Promise<void> {
  if (!env.REALTIME_INTERNAL_URL) return;
  await redis.hset(INSTANCE_REGISTRY_KEY, instanceId, env.REALTIME_INTERNAL_URL);
  await redis.expire(INSTANCE_REGISTRY_KEY, INSTANCE_REGISTRY_TTL_SEC);
}

async function unregisterInstance(): Promise<void> {
  if (!env.REALTIME_INTERNAL_URL) return;
  try {
    await redis.hdel(INSTANCE_REGISTRY_KEY, instanceId);
  } catch {
    // best effort on shutdown
  }
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
    | { type: string; participantIds?: string[]; [key: string]: unknown }
    | undefined;
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    res.status(400).json({ error: "event required" });
    return;
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

  const userId = await redis.get(`session:${token}`);

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
  const prevStatus = await computePresence(redis, userId);

  connections.set(connId, { ws, userId });
  const normId = normUserId(userId);
  if (!userConnections.has(normId)) userConnections.set(normId, new Set());
  userConnections.get(normId)!.add(connId);

  // Register close/error handlers immediately after adding to the map so that if the socket
  // closes during any subsequent await the cleanup always runs and the connection is not leaked.
  ws.on("close", async () => {
    // Remove from local maps synchronously before any await so fanout never
    // finds this closed socket during the async gap.
    connections.delete(connId);
    const closeNormId = normUserId(userId);
    const userConns = userConnections.get(closeNormId);
    if (userConns) {
      userConns.delete(connId);
      if (userConns.size === 0) userConnections.delete(closeNormId);
    }
    logger.info({ userId, connId, total: connections.size }, "client disconnected");
    const prev = await computePresence(redis, userId);
    await removeConnection(redis, userId, connId, instanceId);
    const stillConnectedElsewhere = await hasRegisteredConnections(redis, userId);
    // Broadcast BEFORE unsubscribing — targets are looked up from context sets,
    // which must still be in Redis when broadcastPresenceChange runs.
    await updateAndBroadcast(userId, prev);
    if (!stillConnectedElsewhere) {
      await unsubscribeUser(redis, userId);
    }
  });

  ws.on("error", (err) => {
    logger.error({ err, connId }, "websocket error");
  });

  await registerConnection(redis, userId, connId, instanceId);
  await subscribeUser(redis, userId);

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
      await replayMissedDmHints(ws, userId);
    })();
  });

  // Send current presence snapshot to the newly connected client
  setImmediate(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Send own presence immediately
    ws.send(JSON.stringify({ type: "presence_update", userId, status: currentStatus, awayMessage: currentAwayMessage }));

    // Get all related connected users from Redis and send their presence
    const relatedUserIds = await getPresenceTargets(redis, userId);
    const connectedRelated = relatedUserIds.filter((id) => {
      if (normUserId(id) === normUserId(userId)) return false;
      return (userConnections.get(normUserId(id))?.size ?? 0) > 0;
    });

    const presencePayloads = await Promise.all(
      connectedRelated.map(async (relatedUserId) => {
        const { status, awayMessage } = await buildPresencePayload(relatedUserId);
        return { userId: relatedUserId, status, awayMessage };
      })
    );
    if (ws.readyState !== WebSocket.OPEN) return;
    for (const payload of presencePayloads) {
      ws.send(JSON.stringify({ type: "presence_update", ...payload }));
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

    const prev = await computePresence(redis, userId);

    if (msg.type === "ping") {
      // Keep activity updated on pings
      await updateActivity(redis, userId, connId, instanceId);
    } else if (msg.type === "subscribe_channel") {
      const channelId = (msg as { channelId?: string }).channelId;
      if (typeof channelId === "string" && channelId.length > 0) {
        await subscribeChannel(redis, channelId, userId);
        logger.info({ userId, connId, channelId }, "client subscribed to channel");
      }
    } else if (msg.type === "away") {
      // Manually set away status with an optional message that other users can see
      await setAway(redis, userId, (msg.message as string) ?? "");
      const { status: awayStatus, awayMessage: awayMsg } = await buildPresencePayload(userId);
      await setLastKnownPresence(userId, awayStatus);
      await broadcastPresenceChange(redis, userId, awayStatus, awayMsg);
      return;
    } else if (msg.type === "back") {
      // Manually remove the away status from the redis. Goes back to the previous status before away
      await clearAway(redis, userId);
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
      await broadcastPresenceChange(redis, userId, newStatus, awayMessage);
    }
  }
}, 30_000);

// Subscribe to DM events from the DMS service and forward to relevant WebSocket clients
redisSub.subscribe("dm:events", "community:events", "channel:events", PRESENCE_BROADCAST_CHANNEL, (err) => {
  if (err) logger.error({ err }, "pubsub subscribe failed");
  else logger.info("subscribed to pubsub channels: dm:events, community:events, channel:events, presence:broadcast");
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
        if (conn) safeSend(conn.ws, payload, "presence_broadcast");
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
        await subscribeCommunity(redis, communityId, userId);
        await subscribeAllChannelsForUserInCommunity(redis, userId, communityId);
        // Forward event to all connected members of this community
        await fanOutToGuild(communityId, JSON.stringify(event));
        // Broadcast the new member's presence to all related users (shard-safe via Redis pub/sub)
        const { status: newMemberStatus, awayMessage: newMemberAway } = await buildPresencePayload(userId);
        await broadcastPresenceChange(redis, userId, newMemberStatus, newMemberAway);
        // Send the new member their presence snapshot of existing connected members
        const newMemberConns = userConnections.get(normUserId(userId));
        for (const connId of newMemberConns ?? []) {
          const conn = connections.get(connId);
          if (!conn) continue;
          const { ws } = conn;
          const relatedIds = await getPresenceTargets(redis, userId);
          const connectedRelated = relatedIds.filter((id) => {
            if (normUserId(id) === normUserId(userId)) return false;
            return (userConnections.get(normUserId(id))?.size ?? 0) > 0;
          });
          const payloads = await Promise.all(
            connectedRelated.map(async (rid) => {
              const { status, awayMessage } = await buildPresencePayload(rid);
              return { userId: rid, status, awayMessage };
            })
          );
          for (const p of payloads) {
            safeSend(ws, JSON.stringify({ type: "presence_update", ...p }), "join_snapshot");
          }
        }
      })();
    }

    if (event.type === "community:channel:create") {
      const communityId = event.communityId as string;
      const ch = event.channel as { id?: string; is_private?: boolean } | undefined;
      const channelId = ch?.id;
      if (channelId && ch?.is_private !== true) {
        void subscribeAllMembersForChannel(redis, channelId);
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
        await unsubscribeCommunity(redis, communityId, userId);
        await fanOutToGuild(communityId, JSON.stringify(event));
      })();
    }

    if (event.type === "community:channel:member:add") {
      const channelId = event.channelId as string;
      const userId = event.userId as string;
      const payload = JSON.stringify(event);
      void (async () => {
        await subscribeChannel(redis, channelId, userId);
        const conns = userConnections.get(normUserId(userId));
        if (conns) for (const connId of conns) {
          const conn = connections.get(connId);
          if (conn) safeSend(conn.ws, payload, "ch_member_add");
        }
      })();
    }

    if (event.type === "community:channel:member:remove") {
      const channelId = event.channelId as string;
      const userId = event.userId as string;
      const payload = JSON.stringify(event);
      void (async () => {
        await unsubscribeChannel(redis, channelId, userId);
        const conns = userConnections.get(normUserId(userId));
        if (conns) for (const connId of conns) {
          const conn = connections.get(connId);
          if (conn) safeSend(conn.ws, payload, "ch_member_remove");
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
        const raw = await redis.smembers(`presence:channel:${channelId}`);
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
              safeSend(conn.ws, payload, "channel");
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

  if (channel !== "dm:events") return;

  let event: { type: string; participantIds?: string[]; [key: string]: unknown };
  try {
    event = JSON.parse(message);
  } catch {
    return;
  }

  const targetUserIds = new Set((event.participantIds ?? []).map(normUserId));

  const dmMsg = event.type === "dm:message:create" && event.message && typeof event.message === "object"
    ? event.message as { messageId?: string; authorId?: string; timeuuid?: string; createdAt?: string }
    : null;

  if (event.type === "dm:message:create") {
    logger.info({
      conversationId: event.conversationId,
      messageId: dmMsg?.messageId,
      authorId: dmMsg?.authorId,
      timeuuid: dmMsg?.timeuuid,
      createdAt: dmMsg?.createdAt,
      participantIds: event.participantIds ?? [],
      participantCount: (event.participantIds ?? []).length,
      receivedAt: new Date().toISOString(),
    }, "dm:message:create received from redis");
  }

  const { delivered, localMiss, totalTargets } = fanOutDmEventLocal(event, "pubsub");

  if (event.type === "dm:message:create") {
    logger.info({
      conversationId: event.conversationId,
      messageId: dmMsg?.messageId,
      authorId: dmMsg?.authorId,
      sentCount: delivered,
      notConnectedCount: localMiss,
      totalTargets,
    }, "dm:message:create fanout complete");
  }

  if (event.type === "dm:conversation:create") {
    const conversationId = event.conversationId as string;
    const participants = event.participantIds ?? [];
    void (async () => {
      // Register the new DM in Redis subscription sets
      await subscribeDm(redis, conversationId, participants);
      // Exchange presence between all participants
      await Promise.all(
        participants.map(async (uid) => {
          const { status, awayMessage } = await buildPresencePayload(uid);
          const presencePayload = JSON.stringify({ type: "presence_update", userId: uid, status, awayMessage });
          for (const targetUid of targetUserIds) {
            if (normUserId(targetUid) === normUserId(uid)) continue;
            const conns = userConnections.get(targetUid);
            if (!conns) continue;
            for (const connId of conns) {
              const conn = connections.get(connId);
              if (conn) safeSend(conn.ws, presencePayload, "dm_conv_create_presence");
            }
          }
        })
      );
    })();
  }

  if (event.type === "dm:participant:leave") {
    const conversationId = event.conversationId as string;
    const userId = event.userId as string;
    void unsubscribeDm(redis, conversationId, userId);
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
    void registerInstance().catch((err) =>
      logger.warn({ err }, "instance registry: initial registration failed")
    );
    setInterval(() => {
      void registerInstance().catch((err) =>
        logger.warn({ err }, "instance registry: refresh failed")
      );
    }, INSTANCE_REGISTRY_REFRESH_MS);
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
