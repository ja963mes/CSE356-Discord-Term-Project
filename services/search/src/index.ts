/// <reference path="./types/express.d.ts" />
import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./env";
import { esClient, ensureIndex } from "./elasticsearch";
import { startSubscriber } from "./subscriber";
import searchRouter from "./routes/search";
import directoryRouter from "./routes/directory";
import { ensureCommunitiesIndex, reindexAllCommunitiesFromPostgres } from "./communitiesIndex";
import { redis } from "./redis";

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", async (_req, res) => {
  try {
    await esClient.ping();
    res.json({ status: "ok", service: "search-service", elasticsearch: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", service: "search-service", elasticsearch: "disconnected" });
  }
});

app.use(searchRouter);
app.use(directoryRouter);

const port = Number(env.SEARCH_PORT);

void (async () => {
  await ensureIndex();
  await ensureCommunitiesIndex();
  try {
    const n = await reindexAllCommunitiesFromPostgres();
    console.log(`[search] Reindexed ${n} communities into Elasticsearch`);
    await redis.incr("comm:e:dir").catch(() => {});
  } catch (e) {
    console.error("[search] Community directory reindex failed (ES may be empty until fixed):", e);
  }
  await startSubscriber();
  app.listen(port, () => {
    console.log(`Search service running on port ${port}`);
  });
})();
