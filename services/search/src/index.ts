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

const server = app.listen(port, () => {
  logger.info({ port }, "search-service listening");
});
// keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
// Prevents ERR_INCOMPLETE_CHUNKED_ENCODING when nginx reuses a socket Node just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

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
  try {
    await ensureIndex();
    logger.info({ index: env.ES_INDEX_NAME }, "ensured messages index");
  } catch (e) {
    logger.error({ err: e }, "failed to ensure messages index");
  }

  try {
    await ensureCommunitiesIndex();
    logger.info({ index: env.ES_COMMUNITIES_INDEX_NAME }, "ensured communities directory index");
  } catch (e) {
    logger.error({ err: e }, "failed to ensure communities directory index");
  }

  try {
    const n = await reindexAllCommunitiesFromPostgres();
    logger.info({ count: n }, "reindexed communities into Elasticsearch");
    await redis.incr("comm:e:dir").catch(() => {});
  } catch (e) {
    logger.error({ err: e }, "community directory reindex failed (ES may be stale/empty)");
  }

  try {
    await startSubscriber();
  } catch (e) {
    logger.error({ err: e }, "failed to start redis subscriber");
  }
})();
