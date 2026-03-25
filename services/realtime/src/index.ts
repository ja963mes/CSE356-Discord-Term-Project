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

const redis = new Redis(env.REDIS_URL);
redis.on("connect", async () => {
  console.log("Redis connected");
  // Clear all stale presence connection data from previous server sessions
  // Activity and presence are ephemeral and only relevant while the server is running, so it's safe to clear them on startup
  const keys = await redis.keys("presence:conns:*");
  if (keys.length > 0) {
    await redis.del(...keys);
    console.log(`[startup] cleared ${keys.length} stale presence entries`);
  }
});
redis.on("error", (err) => console.error("Redis error:", err));

// Track active connections: connId -> { ws, userId }
const connections = new Map<string, { ws: WebSocket; userId: string }>();

async function updateAndBroadcast(userId: string, prevStatus: PresenceStatus): Promise<void> {
  const newStatus = await computePresence(redis, userId);
  if (newStatus !== prevStatus) {
    console.log(`[presence] userId=${userId} ${prevStatus} → ${newStatus}`);
    await broadcastPresenceChange(userId, newStatus, connections);
  }
}

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "realtime-service", connections: connections.size });
});

// Internal endpoint — only called by other services, not exposed publicly
app.get("/internal/presence/:userId", async (req, res) => {
  const { userId } = req.params;
  const status = await computePresence(redis, userId);
  res.json({ userId, status });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
  const prevStatus = await computePresence(redis, userId);

  connections.set(connId, { ws, userId });
  await registerConnection(redis, userId, connId);

  console.log(`[connect] userId=${userId} connId=${connId} total=${connections.size}`);
  await updateAndBroadcast(userId, prevStatus);
  const currentStatus = await computePresence(redis, userId);
  lastKnownPresence.set(userId, currentStatus);

  // Always send the current presence to the newly connected client
  const selfPayload = JSON.stringify({ type: "presence_update", userId, status: currentStatus });
  // Use setImmediate to ensure the handshake is fully complete before sending
  setImmediate(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(selfPayload);
  });

  ws.on("message", async (data) => {
    let msg: { type: string; message?: string };

    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const prev = await computePresence(redis, userId);

    if (msg.type === "ping") {
      await updateActivity(redis, userId, connId);
    } else if (msg.type === "away") {
      await setAway(redis, userId, msg.message ?? "");
    } else if (msg.type === "back") {
      await clearAway(redis, userId);
    }

    await updateAndBroadcast(userId, prev);
  });

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

// Track last known presence per user to detect transitions in the idle check
const lastKnownPresence = new Map<string, PresenceStatus>();

// Every 30s check all connected users for idle transitions
// Worst case the ui will update 90s after the user goes idle
// The truth lives on the server and the ui only learns about it when this fires 30s after that 60s idle timeout
setInterval(async () => {
  const checkedUsers = new Set<string>();
  for (const { userId } of connections.values()) {
    if (checkedUsers.has(userId)) continue;
    checkedUsers.add(userId);
    const prev = lastKnownPresence.get(userId) ?? "offline";
    const newStatus = await computePresence(redis, userId);
    lastKnownPresence.set(userId, newStatus);
    if (newStatus !== prev) {
      console.log(`[presence] userId=${userId} ${prev} → ${newStatus}`);
      await broadcastPresenceChange(userId, newStatus, connections);
    }
  }
}, 30_000);

server.listen(Number(env.PORT), () => {
  console.log(`Realtime service running on port ${env.PORT}`);
});
