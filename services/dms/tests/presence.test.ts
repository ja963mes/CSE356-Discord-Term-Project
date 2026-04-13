/**
 * Presence integration tests for DMs.
 *
 * These tests connect real WebSocket clients to the running realtime service
 * (localhost:3005) and verify that presence events flow correctly when DM
 * conversations are created, messages are sent, and users go away/back.
 *
 * Prerequisites: realtime service must be running on port 3005.
 */
import WebSocket from "ws";
import request from "supertest";
import { app } from "../src/app";
import { initializeCassandra, cassandra } from "../src/db";
import { pg } from "../src/db/pg";
import { directConversations, dmParticipants } from "../src/db/pgSchema";
import { inArray } from "drizzle-orm";
import { createTestUser, cleanupUsers, closeConnections, TestUser } from "./helpers";

const REALTIME_URL = "ws://localhost:3005";
const REALTIME_TIMEOUT = 5000;

const createdConversationIds: string[] = [];
const createdUserIds: string[] = [];
let userA: TestUser;
let userB: TestUser;
let userC: TestUser;
let userD: TestUser;

// ─── WebSocket helpers ────────────────────────────────────────────────────────

/** Opens a WebSocket connection authenticated as the given user. Resolves once the socket is open. */
function connectWs(user: TestUser): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(REALTIME_URL, { headers: { cookie: user.cookie } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Waits for the next WS message matching the predicate, or rejects after timeout. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeout = REALTIME_TIMEOUT
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WS message")), timeout);

    const handler = (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

/** Collects all WS messages for a given duration (ms). */
function collectMessages(ws: WebSocket, duration: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const messages: Record<string, unknown>[] = [];
    const handler = (data: WebSocket.RawData) => {
      try { messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      resolve(messages);
    }, duration);
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await initializeCassandra();
  [userA, userB, userC, userD] = await Promise.all([
    createTestUser("presence_test_alice"),
    createTestUser("presence_test_bob"),
    createTestUser("presence_test_carol"),
    createTestUser("presence_test_dave"),
  ]);
  createdUserIds.push(userA.userId, userB.userId, userC.userId, userD.userId);
});

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await pg.delete(dmParticipants).where(inArray(dmParticipants.conversation_id, createdConversationIds));
    await pg.delete(directConversations).where(inArray(directConversations.id, createdConversationIds));
    for (const id of createdConversationIds) {
      await cassandra.execute(
        `DELETE FROM messages_by_conversation WHERE conversation_id = ?`,
        [id],
        { prepare: true }
      );
    }
  }
  await cleanupUsers(createdUserIds);
  await cassandra.shutdown();
  await closeConnections();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WebSocket presence — own presence on connect", () => {
  it("receives own presence_update immediately after connecting", async () => {
    const ws = await connectWs(userA);
    try {
      const msg = await waitForMessage(ws, (m) => m.type === "presence_update" && m.userId === userA.userId);
      expect(msg.status).toMatch(/online|idle/);
    } finally {
      ws.close();
    }
  });
});

describe("WebSocket presence — DM conversation creates mutual presence exchange", () => {
  it("both participants receive each other's presence_update after DM is created", async () => {
    const wsA = await connectWs(userA);
    const wsB = await connectWs(userB);

    // Drain the initial own-presence messages
    await new Promise((r) => setTimeout(r, 300));

    // Start collecting before creating the DM
    const promiseA = waitForMessage(wsA, (m) => m.type === "presence_update" && m.userId === userB.userId);
    const promiseB = waitForMessage(wsB, (m) => m.type === "presence_update" && m.userId === userA.userId);

    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    expect(res.status).toBe(201);
    createdConversationIds.push(res.body.conversation.conversationId);

    const [msgA, msgB] = await Promise.all([promiseA, promiseB]);

    expect(msgA.userId).toBe(userB.userId);
    expect(msgA.status).toMatch(/online|idle|away/);
    expect(msgB.userId).toBe(userA.userId);
    expect(msgB.status).toMatch(/online|idle|away/);

    wsA.close();
    wsB.close();
  });
});

describe("WebSocket presence — away/back status", () => {
  // Uses fresh pair (A + C) so the DM creation always fires the event and mutual presence is guaranteed
  it("participant C receives presence_update when A sets away status", async () => {
    const wsA = await connectWs(userA);
    const wsC = await connectWs(userC);

    const mutualA = waitForMessage(wsA, (m) => m.type === "presence_update" && m.userId === userC.userId);
    const mutualC = waitForMessage(wsC, (m) => m.type === "presence_update" && m.userId === userA.userId);

    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userC.userId] });
    createdConversationIds.push(dmRes.body.conversation.conversationId);

    await Promise.all([mutualA, mutualC]);

    const awayPromise = waitForMessage(
      wsC,
      (m) => m.type === "presence_update" && m.userId === userA.userId && m.status === "away"
    );
    wsA.send(JSON.stringify({ type: "away", message: "In a meeting" }));

    const msg = await awayPromise;
    expect(msg.status).toBe("away");
    expect(msg.awayMessage).toBe("In a meeting");

    const backPromise = waitForMessage(
      wsC,
      (m) => m.type === "presence_update" && m.userId === userA.userId && m.status !== "away"
    );
    wsA.send(JSON.stringify({ type: "back" }));
    await backPromise;

    wsA.close();
    wsC.close();
  });
});

describe("WebSocket presence — offline on disconnect", () => {
  // Uses fresh pair (B + D) so the DM creation always fires the event and mutual presence is guaranteed
  it("participant D receives offline presence_update when B disconnects", async () => {
    const wsB = await connectWs(userB);
    const wsD = await connectWs(userD);

    const mutualB = waitForMessage(wsB, (m) => m.type === "presence_update" && m.userId === userD.userId);
    const mutualD = waitForMessage(wsD, (m) => m.type === "presence_update" && m.userId === userB.userId);

    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userB.cookie)
      .send({ type: "one_to_one", participantIds: [userD.userId] });
    createdConversationIds.push(dmRes.body.conversation.conversationId);

    await Promise.all([mutualB, mutualD]);

    const offlinePromise = waitForMessage(
      wsD,
      (m) => m.type === "presence_update" && m.userId === userB.userId && m.status === "offline"
    );

    wsB.close();

    const msg = await offlinePromise;
    expect(msg.status).toBe("offline");

    wsD.close();
  });
});

describe("WebSocket DM events — message:create forwarded to participants", () => {
  it("B receives dm:message:create WS event when A sends a message", async () => {
    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    const convId = dmRes.body.conversation.conversationId;
    if (!createdConversationIds.includes(convId)) createdConversationIds.push(convId);

    const wsB = await connectWs(userB);
    await new Promise((r) => setTimeout(r, 200));

    const msgPromise = waitForMessage(
      wsB,
      (m) => m.type === "dm:message:create" && m.conversationId === convId
    );

    await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Hey Bob, you there?" });

    const event = await msgPromise;
    expect((event.message as Record<string, unknown>).content).toBe("Hey Bob, you there?");

    wsB.close();
  });

  it("B receives dm:message:edit WS event when A edits a message", async () => {
    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    const convId = dmRes.body.conversation.conversationId;
    if (!createdConversationIds.includes(convId)) createdConversationIds.push(convId);

    const sendRes = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Original" });
    const { messageId, timeuuid } = sendRes.body.message;

    const wsB = await connectWs(userB);
    await new Promise((r) => setTimeout(r, 200));

    const editPromise = waitForMessage(
      wsB,
      (m) => m.type === "dm:message:edit" && m.conversationId === convId
    );

    await request(app)
      .patch(`/dms/${convId}/messages/${encodeURIComponent(timeuuid)}`)
      .set("Cookie", userA.cookie)
      .send({ content: "Edited" });

    const event = await editPromise;
    expect((event.message as Record<string, unknown>).content).toBe("Edited");

    wsB.close();
  });

  it("B receives dm:message:delete WS event when A deletes a message", async () => {
    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    const convId = dmRes.body.conversation.conversationId;
    if (!createdConversationIds.includes(convId)) createdConversationIds.push(convId);

    const sendRes = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Delete me" });
    const { messageId, timeuuid } = sendRes.body.message;

    const wsB = await connectWs(userB);
    await new Promise((r) => setTimeout(r, 200));

    const deletePromise = waitForMessage(
      wsB,
      (m) => m.type === "dm:message:delete" && m.conversationId === convId
    );

    await request(app)
      .delete(`/dms/${convId}/messages/${encodeURIComponent(timeuuid)}`)
      .set("Cookie", userA.cookie);

    const event = await deletePromise;
    expect(event.messageId).toBe(messageId);
    expect(event.id).toBe(messageId);
    expect(event.timeuuid).toBe(timeuuid);
    const delMsg = event.message as Record<string, unknown>;
    expect(delMsg.id).toBe(messageId);
    expect(delMsg.messageId).toBe(messageId);
    expect(delMsg.timeuuid).toBe(timeuuid);

    wsB.close();
  });
});
