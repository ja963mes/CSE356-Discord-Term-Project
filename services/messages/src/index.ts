import { env } from "./env";
import { initializeCassandra } from "./cassandra";
import { initializeBucket } from "./minio";
import { app } from "./app";
import { logger } from "./logger";

const port = Number(env.MESSAGES_PORT ?? env.PORT);

void (async () => {
  await Promise.all([
    initializeCassandra(),
    initializeBucket(),
  ]);
  const server = app.listen(port, () => {
    logger.info({ port, keyspace: env.MESSAGES_CASSANDRA_KEYSPACE }, "messages-service listening");
  });
  // keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
  // Prevents ERR_INCOMPLETE_CHUNKED_ENCODING when nginx reuses a socket Node just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
})();
