import http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookie } from "cookie";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { env } from "./env";
import {
  registerConnection,
  removeConnection,
  updateActivity,
  setAway,
  clearAway,
  computePresence,
  PresenceStatus,
} from "./presence";
import { broadcastPresenceChange } from "./broadcast";
import { getRelatedUserIds } from "./relationships";

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
    await broadcastPresenceChange(userId, newStatus, connections, awayMessage);
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
  await registerConnection(redis, userId, connId);

  console.log(`[connect] userId=${userId} connId=${connId} total=${connections.size}`);
  await updateAndBroadcast(userId, prevStatus);
  const { status: currentStatus, awayMessage: currentAwayMessage } = await buildPresencePayload(userId);
  lastKnownPresence.set(userId, currentStatus);

  // Send current presence snapshot to the newly connected client
  setImmediate(async () => {
    // If the connection has already closed by the time this runs, don't attempt to send
    if (ws.readyState !== WebSocket.OPEN) return;

    // Send own presence to update the UI immediately, instead of waiting for the first 30s idle check to trigger a broadcast
    ws.send(JSON.stringify({ type: "presence_update", userId, status: currentStatus, awayMessage: currentAwayMessage }));

    // For now, getRelatedUserIds returns all other connected users as a stub
    const relatedUserIds = await getRelatedUserIds(userId, connections);
    for (const relatedUserId of relatedUserIds) {
      const { status, awayMessage } = await buildPresencePayload(relatedUserId);
      ws.send(JSON.stringify({ type: "presence_update", userId: relatedUserId, status, awayMessage }));
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
      await broadcastPresenceChange(userId, awayStatus, connections, awayMsg);
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
    await updateAndBroadcast(userId, prev);
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
      await broadcastPresenceChange(userId, newStatus, connections, awayMessage);
    }
  }
}, 30_000);

// Subscribe to DM events from the DMS service and forward to relevant WebSocket clients
redisSub.subscribe("dm:events", (err) => {
  if (err) console.error("[dm:events] subscribe failed:", err);
  else console.log("[dm:events] subscribed");
});

redisSub.on("message", (channel, message) => {
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
});

server.listen(Number(env.PORT), () => {
  console.log(`Realtime service running on port ${env.PORT}`);
});
