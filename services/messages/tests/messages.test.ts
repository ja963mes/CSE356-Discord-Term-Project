import request from "supertest";
import { app } from "../src/app";
import { initializeCassandra } from "../src/cassandra";

jest.mock("../src/minio", () => ({
  initializeBucket: jest.fn().mockResolvedValue(undefined),
  presignUpload: jest.fn().mockResolvedValue("http://localhost:9000/mock"),
  keyToUrl: (key: string) => `http://localhost:9000/discord-attachments/${key}`,
}));

import {
  createTestUser,
  createTestChannel,
  addUserToChannel,
  cleanupUser,
  cleanupChannel,
  TestUser,
  TestChannel,
} from "./helpers";

beforeAll(async () => {
  await initializeCassandra();
}, 30000);

describe("GET /messages", () => {
  let user: TestUser;
  let ch: TestChannel;

  beforeAll(async () => {
    user = await createTestUser();
    ch = await createTestChannel(user.id);
  });

  afterAll(async () => {
    await cleanupChannel(ch.channelId, ch.communityId);
    await cleanupUser(user.id);
  });

  it("returns 401 without session", async () => {
    const res = await request(app).get(`/messages?channelId=${ch.channelId}`);
    expect(res.status).toBe(401);
  });

  it("returns 400 without channelId", async () => {
    const res = await request(app).get("/messages").set("Cookie", user.cookie);
    expect(res.status).toBe(400);
  });

  it("returns empty messages list", async () => {
    const res = await request(app)
      .get(`/messages?channelId=${ch.channelId}`)
      .set("Cookie", user.cookie);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  it("returns 403 for channel user is not a member of", async () => {
    const other = await createTestUser();
    const res = await request(app)
      .get(`/messages?channelId=${ch.channelId}`)
      .set("Cookie", other.cookie);
    expect(res.status).toBe(403);
    await cleanupUser(other.id);
  });
});

describe("POST /messages", () => {
  let user: TestUser;
  let ch: TestChannel;

  beforeAll(async () => {
    user = await createTestUser();
    ch = await createTestChannel(user.id);
  });

  afterAll(async () => {
    await cleanupChannel(ch.channelId, ch.communityId);
    await cleanupUser(user.id);
  });

  it("returns 401 without session", async () => {
    const res = await request(app).post("/messages").send({ channelId: ch.channelId, content: "hi" });
    expect(res.status).toBe(401);
  });

  it("returns 400 without content", async () => {
    const res = await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId });
    expect(res.status).toBe(400);
  });

  it("creates a message and returns it", async () => {
    const res = await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId, content: "Hello world" });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      authorId: user.id,
      content: "Hello world",
      attachmentKeys: [],
    });
    expect(typeof res.body.message.timeuuid).toBe("string");
    expect(typeof res.body.message.createdAt).toBe("string");
  });

  it("message appears in GET /messages", async () => {
    await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId, content: "Listed message" });

    const res = await request(app)
      .get(`/messages?channelId=${ch.channelId}`)
      .set("Cookie", user.cookie);
    expect(res.status).toBe(200);
    const found = res.body.messages.find((m: { content: string }) => m.content === "Listed message");
    expect(found).toBeDefined();
  });
});

describe("PATCH /messages/:channelId/:timeuuid", () => {
  let user: TestUser;
  let other: TestUser;
  let ch: TestChannel;
  let timeuuid: string;

  beforeAll(async () => {
    user = await createTestUser();
    other = await createTestUser();
    ch = await createTestChannel(user.id);
    await addUserToChannel(other.id, ch.communityId, ch.channelId);

    const res = await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId, content: "Original" });
    timeuuid = res.body.message.timeuuid;
  });

  afterAll(async () => {
    await cleanupChannel(ch.channelId, ch.communityId);
    await cleanupUser(user.id);
    await cleanupUser(other.id);
  });

  it("edits own message", async () => {
    const res = await request(app)
      .patch(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", user.cookie)
      .send({ content: "Edited content" });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("Edited content");
    expect(res.body.editedAt).toBeDefined();
  });

  it("returns 403 when editing another user's message", async () => {
    const res = await request(app)
      .patch(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", other.cookie)
      .send({ content: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("returns 400 with empty content", async () => {
    const res = await request(app)
      .patch(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", user.cookie)
      .send({ content: "" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /messages/:channelId/:timeuuid", () => {
  let user: TestUser;
  let other: TestUser;
  let ch: TestChannel;

  beforeAll(async () => {
    user = await createTestUser();
    other = await createTestUser();
    ch = await createTestChannel(user.id);
    await addUserToChannel(other.id, ch.communityId, ch.channelId);
  });

  afterAll(async () => {
    await cleanupChannel(ch.channelId, ch.communityId);
    await cleanupUser(user.id);
    await cleanupUser(other.id);
  });

  it("returns 403 when deleting another user's message", async () => {
    const postRes = await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId, content: "Delete target" });
    const { timeuuid } = postRes.body.message;

    const res = await request(app)
      .delete(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", other.cookie);
    expect(res.status).toBe(403);
  });

  it("deletes own message", async () => {
    const postRes = await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId, content: "Will be deleted" });
    const { timeuuid } = postRes.body.message;

    const delRes = await request(app)
      .delete(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", user.cookie);
    expect(delRes.status).toBe(204);

    const listRes = await request(app)
      .get(`/messages?channelId=${ch.channelId}`)
      .set("Cookie", user.cookie);
    const found = listRes.body.messages.find((m: { timeuuid: string }) => m.timeuuid === timeuuid);
    expect(found).toBeUndefined();
  });

  it("returns 404 for already-deleted message", async () => {
    const postRes = await request(app)
      .post("/messages")
      .set("Cookie", user.cookie)
      .send({ channelId: ch.channelId, content: "Double delete" });
    const { timeuuid } = postRes.body.message;

    await request(app)
      .delete(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", user.cookie);

    const res = await request(app)
      .delete(`/messages/${ch.channelId}/${timeuuid}`)
      .set("Cookie", user.cookie);
    expect(res.status).toBe(404);
  });
});
