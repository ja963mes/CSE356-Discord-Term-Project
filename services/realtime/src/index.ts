import http from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { parse as parseCookie } from "cookie";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import { env } from "./env";

const redis = new Redis(env.REDIS_URL);
redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err) => console.error("Redis error:", err));

// Track active connections: connId -> { ws, userId }
const connections = new Map<string, { ws: WebSocket; userId: string }>();

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
  connections.set(connId, { ws, userId });
  console.log(`[connect] userId=${userId} connId=${connId} total=${connections.size}`);

  ws.on("close", () => {
    connections.delete(connId);
    console.log(`[disconnect] userId=${userId} connId=${connId} total=${connections.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[error] connId=${connId}`, err);
  });
});

server.listen(Number(env.PORT), () => {
  console.log(`Realtime service running on port ${env.PORT}`);
});
