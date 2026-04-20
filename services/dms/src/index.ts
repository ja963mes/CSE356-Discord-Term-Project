import { env } from "./env";
import { initializeCassandra } from "./cassandra";
import { initializeBucket } from "./minio";
import { app } from "./app";
import { logger } from "./logger";

const port = Number(env.DMS_PORT);

void (async () => {
  try {
    await Promise.all([initializeCassandra(), initializeBucket()]);
    app.listen(port, () => {
      logger.info({ port, keyspace: env.CASSANDRA_KEYSPACE }, "dms-service listening");
    });
  } catch (err) {
    logger.error({ err }, "failed to initialize");
    process.exit(1);
  }
})();
