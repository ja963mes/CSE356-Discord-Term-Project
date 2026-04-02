import request from "supertest";
import { app } from "../src/app";
import { initializeCassandra } from "../src/cassandra";
import { createTestUser, cleanupUser, TestUser } from "./helpers";

jest.mock("../src/minio", () => ({
  initializeBucket: jest.fn().mockResolvedValue(undefined),
  presignUpload: jest.fn().mockImplementation((key: string) =>
    Promise.resolve(`http://localhost:9000/discord-attachments/${key}?mock-sig`)
  ),
  keyToUrl: (key: string) => `http://localhost:9000/discord-attachments/${key}`,
}));

beforeAll(async () => {
  await initializeCassandra();
}, 30000);

describe("POST /attachments/presign", () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createTestUser();
  });

  afterAll(async () => {
    await cleanupUser(user.id);
  });

  it("returns 401 without session", async () => {
    const res = await request(app)
      .post("/attachments/presign")
      .send({ files: [{ filename: "test.png", contentType: "image/png" }] });
    expect(res.status).toBe(401);
  });

  it("returns 400 with no files", async () => {
    const res = await request(app)
      .post("/attachments/presign")
      .set("Cookie", user.cookie)
      .send({ files: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 with too many files", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({
      filename: `file${i}.png`,
      contentType: "image/png",
    }));
    const res = await request(app)
      .post("/attachments/presign")
      .set("Cookie", user.cookie)
      .send({ files });
    expect(res.status).toBe(400);
  });

  it("returns 400 with unsupported content type", async () => {
    const res = await request(app)
      .post("/attachments/presign")
      .set("Cookie", user.cookie)
      .send({ files: [{ filename: "file.pdf", contentType: "application/pdf" }] });
    expect(res.status).toBe(400);
  });

  it("returns presigned URLs for valid image files", async () => {
    const res = await request(app)
      .post("/attachments/presign")
      .set("Cookie", user.cookie)
      .send({
        files: [
          { filename: "photo.jpg", contentType: "image/jpeg" },
          { filename: "screenshot.png", contentType: "image/png" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(2);
    for (const f of res.body.files) {
      expect(typeof f.key).toBe("string");
      expect(typeof f.uploadUrl).toBe("string");
      // key should contain the sanitized filename
      expect(f.key).toMatch(/\.(jpg|png)$/);
    }
  });

  it("sanitizes filenames in the returned key", async () => {
    const res = await request(app)
      .post("/attachments/presign")
      .set("Cookie", user.cookie)
      .send({ files: [{ filename: "my file (1).png", contentType: "image/png" }] });
    expect(res.status).toBe(200);
    const key: string = res.body.files[0].key;
    // Key should not contain spaces or parens — "my file (1).png" → "my_file__1_.png"
    expect(key).toMatch(/^[0-9a-f-]+-my_file__1_\.png$/);
  });

  it("accepts all allowed content types", async () => {
    const types = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    for (const contentType of types) {
      const res = await request(app)
        .post("/attachments/presign")
        .set("Cookie", user.cookie)
        .send({ files: [{ filename: "img.bin", contentType }] });
      expect(res.status).toBe(200);
    }
  });
});
