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
import { logger } from "./logger";

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", async (_req, res) => {
  try {
    await esClient.ping();
    res.json({ status: "ok", service: "search-service", elasticsearch: "connected" });
  } catch (err) {
    logger.warn({ err }, "health check: elasticsearch ping failed");
    res.status(503).json({ status: "degraded", service: "search-service", elasticsearch: "disconnected" });
  }
});

app.use(searchRouter);
app.use(directoryRouter);

const port = Number(env.SEARCH_PORT);

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception; exiting");
  process.exit(1);
});

void (async () => {
  logger.info(
    {
      port,
      elasticsearchUrl: env.ELASTICSEARCH_URL,
      redisUrl: env.REDIS_URL,
      esIndex: env.ES_INDEX_NAME,
      communitiesIndex: env.ES_COMMUNITIES_INDEX_NAME,
    },
    "search-service booting"
  );
  await ensureIndex();
  logger.info({ index: env.ES_INDEX_NAME }, "ensured messages index");
  await ensureCommunitiesIndex();
  logger.info({ index: env.ES_COMMUNITIES_INDEX_NAME }, "ensured communities directory index");
  try {
    const n = await reindexAllCommunitiesFromPostgres();
    logger.info({ count: n }, "reindexed communities into Elasticsearch");
    await redis.incr("comm:e:dir").catch(() => {});
  } catch (e) {
    logger.error({ err: e }, "community directory reindex failed (ES may be stale/empty)");
  }
  await startSubscriber();
  app.listen(port, () => {
    logger.info({ port }, "search-service listening");
  });
})();
