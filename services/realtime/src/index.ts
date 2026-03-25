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
redis.on("connect", () => console.log("Redis connected"));
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

server.listen(Number(env.PORT), () => {
  console.log(`Realtime service running on port ${env.PORT}`);
});
