import http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookie } from "cookie";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { env } from "./env";
import { initDb } from "./db";
import {
  registerConnection,
  removeConnection,
  updateActivity,
  setAway,
  clearAway,
  computePresence,
  PresenceStatus,
} from "./presence";
import { broadcastPresenceChange, PRESENCE_BROADCAST_CHANNEL, PresenceBroadcastMessage } from "./broadcast";
import { subscribeUser, unsubscribeUser, subscribeDm, unsubscribeDm, subscribeCommunity, unsubscribeCommunity, getPresenceTargets } from "./subscriptions";

const redis = new Redis(env.REDIS_URL);
redis.on("connect", async () => {
  console.log("Redis connected");
  // Clear all stale presence connection data from previous server sessions
  // Activity and presence are only relevant while the server is running, so it's safe to clear them on startup
  const keys = await redis.keys("presence:conns:*");
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`[startup] cleared ${keys.length} stale presence entries`);
  }
});
redis.on("error", (err) => console.error("Redis error:", err));

// Dedicated Redis client for pub/sub (ioredis requires a separate connection for subscriptions)
const redisSub = new Redis(env.REDIS_URL);
redisSub.on("error", (err) => console.error("Redis sub error:", err));

// Track active connections: connId -> { ws, userId }
const connections = new Map<string, { ws: WebSocket; userId: string }>();

// Track last known presence per user to detect transitions in the idle check
const lastKnownPresence = new Map<string, PresenceStatus>();

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
    console.log(`[presence] userId=${userId} ${prevStatus} → ${newStatus}`);
    await broadcastPresenceChange(redis, userId, newStatus, awayMessage);
    lastKnownPresence.set(userId, newStatus);
  }
}

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "realtime-service", connections: connections.size });
});

// Internal endpoint — only called by other services, not exposed publicly
app.get("/internal/presence/:userId", async (req, res) => {
  const { userId } = req.params;
  const { status, awayMessage } = await buildPresencePayload(userId);
  res.json({ userId, status, awayMessage });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
  // Get the user's current presence before registering the new connection
  const prevStatus = await computePresence(redis, userId);

  connections.set(connId, { ws, userId });
  await Promise.all([
    registerConnection(redis, userId, connId),
    subscribeUser(redis, userId),
  ]);

  console.log(`[connect] userId=${userId} connId=${connId} total=${connections.size}`);
  await updateAndBroadcast(userId, prevStatus);
  const { status: currentStatus, awayMessage: currentAwayMessage } = await buildPresencePayload(userId);
  lastKnownPresence.set(userId, currentStatus);

  // Send current presence snapshot to the newly connected client
  setImmediate(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Send own presence immediately
    ws.send(JSON.stringify({ type: "presence_update", userId, status: currentStatus, awayMessage: currentAwayMessage }));

    // Get all related connected users from Redis and send their presence
    const relatedUserIds = await getPresenceTargets(redis, userId);
    const connectedRelated = relatedUserIds.filter((id) => {
      if (id === userId) return false;
      for (const { userId: uid } of connections.values()) {
        if (uid === id) return true;
      }
      return false;
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
      await updateActivity(redis, userId, connId);
    } else if (msg.type === "away") {
      // Manually set away status with an optional message that other users can see
      await setAway(redis, userId, (msg.message as string) ?? "");
      const { status: awayStatus, awayMessage: awayMsg } = await buildPresencePayload(userId);
      lastKnownPresence.set(userId, awayStatus);
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

  // On close, remove the connection and broadcast presence if it changed
  ws.on("close", async () => {
    const prev = await computePresence(redis, userId);
    connections.delete(connId);
    await removeConnection(redis, userId, connId);
    console.log(`[disconnect] userId=${userId} connId=${connId} total=${connections.size}`);
    const stillConnected = [...connections.values()].some((c) => c.userId === userId);
    // Broadcast BEFORE unsubscribing — targets are looked up from context sets,
    // which must still be in Redis when broadcastPresenceChange runs.
    await updateAndBroadcast(userId, prev);
    if (!stillConnected) {
      await unsubscribeUser(redis, userId);
    }
  });

  ws.on("error", (err) => {
    console.error(`[error] connId=${connId}`, err);
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
    const prev = lastKnownPresence.get(userId) ?? "offline";
    const { status: newStatus, awayMessage } = await buildPresencePayload(userId);
    lastKnownPresence.set(userId, newStatus);
    if (newStatus !== prev) {
      console.log(`[presence] userId=${userId} ${prev} → ${newStatus}`);
      await broadcastPresenceChange(redis, userId, newStatus, awayMessage);
    }
  }
}, 30_000);

// Subscribe to DM events from the DMS service and forward to relevant WebSocket clients
redisSub.subscribe("dm:events", "community:events", PRESENCE_BROADCAST_CHANNEL, (err) => {
  if (err) console.error("[pubsub] subscribe failed:", err);
  else console.log("[pubsub] subscribed to dm:events + community:events + presence:broadcast");
});

redisSub.on("message", (channel, message) => {
  if (channel === PRESENCE_BROADCAST_CHANNEL) {
    let msg: PresenceBroadcastMessage;
    try { msg = JSON.parse(message); } catch { return; }
    const targetSet = new Set(msg.targets);
    const payload = JSON.stringify({ type: "presence_update", userId: msg.userId, status: msg.status, awayMessage: msg.awayMessage });
    for (const { ws, userId: connUserId } of connections.values()) {
      if (targetSet.has(connUserId) && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
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
        // Forward event to all connected members of this community
        const payload = JSON.stringify(event);
        for (const { ws, userId: connUserId } of connections.values()) {
          // Send to all members of the community (those subscribed to it)
          const contexts = await redis.smembers(`presence:contexts:${connUserId}`);
          if (contexts.includes(`guild:${communityId}`) && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
          }
        }
        // Broadcast the new member's presence to all related users (shard-safe via Redis pub/sub)
        const { status: newMemberStatus, awayMessage: newMemberAway } = await buildPresencePayload(userId);
        await broadcastPresenceChange(redis, userId, newMemberStatus, newMemberAway);
        // Send the new member their presence snapshot of existing connected members
        for (const { ws, userId: connUserId } of connections.values()) {
          if (connUserId !== userId) continue;
          const relatedIds = await getPresenceTargets(redis, userId);
          const connectedRelated = relatedIds.filter((id) => {
            if (id === userId) return false;
            for (const { userId: uid } of connections.values()) {
              if (uid === id) return true;
            }
            return false;
          });
          const payloads = await Promise.all(
            connectedRelated.map(async (rid) => {
              const { status, awayMessage } = await buildPresencePayload(rid);
              return { userId: rid, status, awayMessage };
            })
          );
          for (const p of payloads) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "presence_update", ...p }));
            }
          }
        }
      })();
    }

    if (event.type === "community:channel:create" || event.type === "community:channel:delete") {
      const communityId = event.communityId as string;
      const payload = JSON.stringify(event);
      void (async () => {
        for (const { ws, userId: connUserId } of connections.values()) {
          const contexts = await redis.smembers(`presence:contexts:${connUserId}`);
          if (contexts.includes(`guild:${communityId}`) && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
          }
        }
      })();
    }

    if (event.type === "community:member:leave") {
      const communityId = event.communityId as string;
      const userId = event.userId as string;
      void (async () => {
        await unsubscribeCommunity(redis, communityId, userId);
        const payload = JSON.stringify(event);
        for (const { ws, userId: connUserId } of connections.values()) {
          const contexts = await redis.smembers(`presence:contexts:${connUserId}`);
          if (contexts.includes(`guild:${communityId}`) && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
          }
        }
      })();
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

  const targetUserIds = new Set(event.participantIds ?? []);
  const payload = JSON.stringify(event);

  for (const { ws, userId } of connections.values()) {
    if (targetUserIds.has(userId) && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
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
          for (const { ws, userId: connUserId } of connections.values()) {
            if (targetUserIds.has(connUserId) && connUserId !== uid && ws.readyState === WebSocket.OPEN) {
              ws.send(presencePayload);
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
    server.listen(Number(env.PORT), () => {
      console.log(`Realtime service running on port ${env.PORT}`);
    });
  })
  .catch((err) => {
    console.error("[realtime] failed to initialize DB", err);
    process.exit(1);
  });
