import { env } from "./env";
import { initializeCassandra } from "./cassandra";
import { startSubscriber } from "./subscriber";
import { app } from "./app";
import { flushMentionsForShutdown } from "./repo";
import { logger } from "./logger";

const port = Number(env.READ_STATE_PORT);

void (async () => {
  await initializeCassandra();
  if (process.env.READ_STATE_SUBSCRIBER !== "false") {
    await startSubscriber();
  }
  const server = app.listen(port, () => {
    logger.info({ port, cassandraKeyspace: env.READ_STATE_CASSANDRA_KEYSPACE }, "read-state-service listening");
  });
  // keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
  // Prevents ERR_INCOMPLETE_CHUNKED_ENCODING when nginx reuses a socket Node just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
})();

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "flushing pending mentions before shutdown");
  try { await flushMentionsForShutdown(); } catch (err) { logger.error({ err }, "mention flush on shutdown failed"); }
  process.exit(0);
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
