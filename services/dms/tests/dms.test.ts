import request from "supertest";
import express from "express";
import { createTestUser, cleanupUsers, closeConnections, TestUser } from "./helpers";
import { initializeCassandra, cassandra } from "../src/db";
import { pg } from "../src/db/pg";
import { directConversations, dmParticipants } from "../src/db/pgSchema";
import { inArray } from "drizzle-orm";

// Import the app factory — we need to build the express app without calling listen()
// So we extract app setup from index.ts into a separate module.
// For now we import the app directly via a small re-export.
import { app } from "../src/app";

let userA: TestUser;
let userB: TestUser;
let userC: TestUser;
const createdConversationIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  await initializeCassandra();
  [userA, userB, userC] = await Promise.all([
    createTestUser("dms_test_alice"),
    createTestUser("dms_test_bob"),
    createTestUser("dms_test_carol"),
  ]);
  createdUserIds.push(userA.userId, userB.userId, userC.userId);
});

afterAll(async () => {
  // Clean up conversations
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

// ─── Auth guard ──────────────────────────────────────────────────────────────

describe("Auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/dms");
    expect(res.status).toBe(401);
  });
});

// ─── Create conversation ──────────────────────────────────────────────────────

describe("POST /dms — create conversation", () => {
  it("creates a 1-to-1 conversation", async () => {
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });

    expect(res.status).toBe(201);
    expect(res.body.conversation.conversationType).toBe("one_to_one");
    expect(res.body.conversation.participantIds).toHaveLength(2);
    expect(res.body.conversation.participantIds).toContain(userA.userId);
    expect(res.body.conversation.participantIds).toContain(userB.userId);
    createdConversationIds.push(res.body.conversation.conversationId);
  });

  it("returns the same conversation when creating a duplicate 1-to-1", async () => {
    const res1 = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });

    const res2 = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.conversation.conversationId).toBe(res2.body.conversation.conversationId);
  });

  it("creates a group conversation with a name", async () => {
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "group", participantIds: [userB.userId, userC.userId], name: "Test Group" });

    expect(res.status).toBe(201);
    expect(res.body.conversation.conversationType).toBe("group");
    expect(res.body.conversation.name).toBe("Test Group");
    expect(res.body.conversation.participantIds).toHaveLength(3);
    createdConversationIds.push(res.body.conversation.conversationId);
  });

  it("rejects 1-to-1 with wrong participant count", async () => {
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId, userC.userId] });

    expect(res.status).toBe(400);
  });

  it("rejects group with only one participant", async () => {
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "group", participantIds: [] });

    expect(res.status).toBe(400);
  });
});

// ─── List conversations ───────────────────────────────────────────────────────

describe("GET /dms — list conversations", () => {
  it("returns conversations for the authenticated user", async () => {
    const res = await request(app)
      .get("/dms")
      .set("Cookie", userA.cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.conversations)).toBe(true);
    expect(res.body.conversations.length).toBeGreaterThanOrEqual(1);
  });

  it("does not return conversations the user is not part of", async () => {
    // Create a conversation between B and C only
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userB.cookie)
      .send({ type: "one_to_one", participantIds: [userC.userId] });
    expect(res.status).toBe(201);
    const bcId = res.body.conversation.conversationId;
    createdConversationIds.push(bcId);

    const listRes = await request(app).get("/dms").set("Cookie", userA.cookie);
    const ids = listRes.body.conversations.map((c: { conversationId: string }) => c.conversationId);
    expect(ids).not.toContain(bcId);
  });
});

// ─── Messages ─────────────────────────────────────────────────────────────────

describe("Messages", () => {
  let convId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    convId = res.body.conversation.conversationId;
    if (!createdConversationIds.includes(convId)) createdConversationIds.push(convId);
  });

  it("sends a message", async () => {
    const res = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Hello Bob!" });

    expect(res.status).toBe(201);
    expect(res.body.message.content).toBe("Hello Bob!");
    expect(res.body.message.authorId).toBe(userA.userId);
  });

  it("rejects empty message content", async () => {
    const res = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "   " });

    expect(res.status).toBe(400);
  });

  it("lists messages", async () => {
    await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Message 1" });
    await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Message 2" });

    const res = await request(app)
      .get(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie);

    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("non-participant cannot read messages", async () => {
    const res = await request(app)
      .get(`/dms/${convId}/messages`)
      .set("Cookie", userC.cookie);

    expect(res.status).toBe(403);
  });

  it("edits a message", async () => {
    const sendRes = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Original content" });
    expect(sendRes.status).toBe(201);
    const { messageId, timeuuid } = sendRes.body.message;

    const editRes = await request(app)
      .patch(`/dms/${convId}/messages/${encodeURIComponent(timeuuid)}`)
      .set("Cookie", userA.cookie)
      .send({ content: "Edited content" });

    expect(editRes.status).toBe(200);
    expect(editRes.body.message.content).toBe("Edited content");
  });

  it("cannot edit another user's message", async () => {
    const sendRes = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Alice's message" });
    const { timeuuid } = sendRes.body.message;

    const editRes = await request(app)
      .patch(`/dms/${convId}/messages/${encodeURIComponent(timeuuid)}`)
      .set("Cookie", userB.cookie)
      .send({ content: "Hacked!" });

    expect(editRes.status).toBe(403);
  });

  it("deletes a message", async () => {
    const sendRes = await request(app)
      .post(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie)
      .send({ content: "Delete me" });
    const { messageId, timeuuid } = sendRes.body.message;

    const delRes = await request(app)
      .delete(`/dms/${convId}/messages/${encodeURIComponent(timeuuid)}`)
      .set("Cookie", userA.cookie);

    expect(delRes.status).toBe(204);

    // Verify it shows as deleted in the list
    const listRes = await request(app)
      .get(`/dms/${convId}/messages`)
      .set("Cookie", userA.cookie);
    const deleted = listRes.body.messages.find((m: { messageId: string }) => m.messageId === messageId);
    expect(deleted?.deleted).toBe(true);
    expect(deleted?.content).toBe("");
  });
});

// ─── Invite & leave ───────────────────────────────────────────────────────────

describe("Participants", () => {
  let groupId: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "group", participantIds: [userB.userId] });
    groupId = res.body.conversation.conversationId;
    createdConversationIds.push(groupId);
  });

  it("invites a new participant to a group", async () => {
    const res = await request(app)
      .post(`/dms/${groupId}/participants`)
      .set("Cookie", userA.cookie)
      .send({ userId: userC.userId });

    expect(res.status).toBe(204);

    // Verify C appears in the conversation
    const listRes = await request(app).get("/dms").set("Cookie", userC.cookie);
    const ids = listRes.body.conversations.map((c: { conversationId: string }) => c.conversationId);
    expect(ids).toContain(groupId);
  });

  it("cannot invite to a 1-to-1 conversation", async () => {
    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    const dmId = dmRes.body.conversation.conversationId;

    const res = await request(app)
      .post(`/dms/${dmId}/participants`)
      .set("Cookie", userA.cookie)
      .send({ userId: userC.userId });

    expect(res.status).toBe(400);
  });

  it("leaves a group conversation", async () => {
    const res = await request(app)
      .delete(`/dms/${groupId}/participants/me`)
      .set("Cookie", userC.cookie);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);

    // C should no longer see the conversation
    const listRes = await request(app).get("/dms").set("Cookie", userC.cookie);
    const ids = listRes.body.conversations.map((c: { conversationId: string }) => c.conversationId);
    expect(ids).not.toContain(groupId);
  });

  it("hard deletes the conversation when last member leaves a 1-to-1", async () => {
    const dmRes = await request(app)
      .post("/dms")
      .set("Cookie", userA.cookie)
      .send({ type: "one_to_one", participantIds: [userB.userId] });
    const dmId = dmRes.body.conversation.conversationId;

    const res = await request(app)
      .delete(`/dms/${dmId}/participants/me`)
      .set("Cookie", userA.cookie);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
