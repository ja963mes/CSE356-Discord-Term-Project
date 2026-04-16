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
  app.listen(port, () => {
    logger.info({ port, keyspace: env.MESSAGES_CASSANDRA_KEYSPACE }, "messages-service listening");
  });
})();
