import { env } from "./env";
import { initializeCassandra } from "./cassandra";
import { initializeBucket } from "./minio";
import { app } from "./app";

const port = Number(env.MESSAGES_PORT ?? env.PORT);

void (async () => {
  await Promise.all([
    initializeCassandra(),
    initializeBucket(),
  ]);
  app.listen(port, () => {
    console.log(`Messages service running on port ${port} (Cassandra keyspace=${env.MESSAGES_CASSANDRA_KEYSPACE})`);
  });
})();
