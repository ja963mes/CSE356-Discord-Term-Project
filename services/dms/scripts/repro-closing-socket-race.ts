import { randomUUID } from "crypto";
import path from "path";
import dotenv from "dotenv";
import { Pool } from "pg";
import Redis from "ioredis";
import WebSocket from "ws";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
if (process.env.ENV_FILE) {
  dotenv.config({ path: process.env.ENV_FILE, override: true });
}

const DATABASE_URL = process.env.DATABASE_URL;
const KV_REDIS_URL = process.env.KV_REDIS_URL ?? process.env.REDIS_URL;
const DMS_BASE_URL = process.env.DMS_BASE_URL ?? "http://127.0.0.1:3007";
const REALTIME_WS_URL = process.env.REALTIME_WS_URL ?? "ws://127.0.0.1:3005";
const ATTEMPTS = parseInt(process.env.CLOSING_SOCKET_ATTEMPTS ?? "20", 10);
const DELIVERY_TIMEOUT_MS = parseInt(process.env.CLOSING_SOCKET_TIMEOUT_MS ?? "4000", 10);
const RECONNECT_DELAY_MS = parseInt(process.env.CLOSING_SOCKET_RECONNECT_DELAY_MS ?? "150", 10);

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!KV_REDIS_URL) throw new Error("KV_REDIS_URL or REDIS_URL is required");

type TestUser = { userId: string; username: string; cookie: string; sessionToken: string };
type JsonRecord = Record<string, unknown>;

const pg = new Pool({ connectionString: DATABASE_URL });
const kvRedis = new Redis(KV_REDIS_URL);

async function createTestUser(prefix: string): Promise<TestUser> {
  const userId = randomUUID();
  const username = `${prefix}_${userId.slice(0, 8)}`;
  await pg.query(
    `INSERT INTO users (internal_id, username, email, profile) VALUES ($1, $2, $3, '{}')`,
    [userId, username, `${username}@test.local`]
  );
  const sessionToken = randomUUID();
  await kvRedis.set(`session:${sessionToken}`, userId, "EX", 3600);
  return { userId, username, sessionToken, cookie: `session_token=${sessionToken}` };
}

async function cleanupUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await pg.query(`DELETE FROM users WHERE internal_id = ANY($1::uuid[])`, [userIds]);
}

function connectWs(user: TestUser): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(REALTIME_WS_URL, { headers: { cookie: user.cookie } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: JsonRecord) => boolean,
  timeoutMs: number
): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: WebSocket.RawData) => {
      let msg: JsonRecord;
      try {
        msg = JSON.parse(data.toString()) as JsonRecord;
      } catch {
        return;
      }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      ws.off("message", handler);
      resolve(msg);
    };

    ws.on("message", handler);
  });
}

function waitForReadyState(ws: WebSocket, readyState: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (ws.readyState === readyState) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error(`Socket never reached readyState=${readyState}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function jsonFetch(url: string, init: RequestInit & { cookie?: string } = {}): Promise<JsonRecord> {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  const res = await fetch(url, { ...init, headers });
  const body = (await res.json()) as JsonRecord;
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed: ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function createConversation(sender: TestUser, recipient: TestUser): Promise<string> {
  const body = await jsonFetch(`${DMS_BASE_URL}/dms`, {
    method: "POST",
    cookie: sender.cookie,
    body: JSON.stringify({ type: "one_to_one", participantIds: [recipient.userId] }),
  });
  const conversation = body.conversation as { conversationId?: string } | undefined;
  if (!conversation?.conversationId) throw new Error(`Conversation creation returned no id: ${JSON.stringify(body)}`);
  return conversation.conversationId;
}

async function sendMessage(sender: TestUser, conversationId: string, content: string): Promise<{ messageId: string }> {
  const body = await jsonFetch(`${DMS_BASE_URL}/dms/${conversationId}/messages`, {
    method: "POST",
    cookie: sender.cookie,
    body: JSON.stringify({ content }),
  });
  const message = body.message as { messageId?: string } | undefined;
  if (!message?.messageId) throw new Error(`Message send returned no id: ${JSON.stringify(body)}`);
  return { messageId: message.messageId };
}

async function listMessages(user: TestUser, conversationId: string): Promise<JsonRecord[]> {
  const body = await jsonFetch(`${DMS_BASE_URL}/dms/${conversationId}/messages?limit=20`, {
    method: "GET",
    cookie: user.cookie,
  });
  const messages = body.messages;
  return Array.isArray(messages) ? (messages as JsonRecord[]) : [];
}

async function runAttempt(sender: TestUser, recipient: TestUser, attempt: number): Promise<boolean> {
  const senderWs = await connectWs(sender);
  const recipientWs = await connectWs(recipient);
  let recipientReconnect: WebSocket | null = null;

  try {
    await new Promise((r) => setTimeout(r, 200));
    const conversationId = await createConversation(sender, recipient);
    const content = `closing-socket-race attempt=${attempt} id=${randomUUID()}`;

    recipientWs.close(1000, "intentional closing-socket race");
    await waitForReadyState(recipientWs, WebSocket.CLOSING, 250);

    const { messageId } = await sendMessage(sender, conversationId, content);

    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    recipientReconnect = await connectWs(recipient);

    const recovered = await waitForMessage(
      recipientReconnect,
      (msg) =>
        msg.type === "dm:message:create" &&
        msg.conversationId === conversationId &&
        typeof (msg.message as JsonRecord | undefined)?.messageId === "string" &&
        ((msg.message as JsonRecord).messageId as string) === messageId,
      DELIVERY_TIMEOUT_MS
    );

    const messages = await listMessages(recipient, conversationId);
    const persisted = messages.some((msg) => (msg.messageId as string | undefined) === messageId);

    console.log(
      JSON.stringify(
        {
          attempt,
          reproduced: true,
          conversationId,
          messageId,
          oldSocketReadyState: recipientWs.readyState,
          recoveredSource: recovered.source ?? "live_or_unknown",
          persisted,
        },
        null,
        2
      )
    );
    return true;
  } catch (err) {
    console.error(
      JSON.stringify(
        {
          attempt,
          reproduced: false,
          error: err instanceof Error ? err.message : String(err),
        },
        null,
        2
      )
    );
    return false;
  } finally {
    senderWs.close();
    recipientWs.close();
    recipientReconnect?.close();
  }
}

async function main(): Promise<void> {
  const createdUserIds: string[] = [];
  try {
    const sender = await createTestUser("closing_socket_sender");
    const recipient = await createTestUser("closing_socket_recipient");
    createdUserIds.push(sender.userId, recipient.userId);

    console.log(
      JSON.stringify(
        {
          dmsBaseUrl: DMS_BASE_URL,
          realtimeWsUrl: REALTIME_WS_URL,
          attempts: ATTEMPTS,
          reconnectDelayMs: RECONNECT_DELAY_MS,
          deliveryTimeoutMs: DELIVERY_TIMEOUT_MS,
          senderUserId: sender.userId,
          recipientUserId: recipient.userId,
        },
        null,
        2
      )
    );

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const ok = await runAttempt(sender, recipient, attempt);
      if (ok) {
        console.log("Reproduced closing-socket delivery race.");
        console.log("If the old bug is present, realtime logs should show: ws not open, dropping send");
        return;
      }
    }

    console.error(`Failed to reproduce the race in ${ATTEMPTS} attempts.`);
    process.exitCode = 1;
  } finally {
    await cleanupUsers(createdUserIds);
    await kvRedis.quit();
    await pg.end();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
