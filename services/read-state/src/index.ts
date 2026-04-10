import { env } from "./env";
import { initializeCassandra } from "./cassandra";
import { startSubscriber } from "./subscriber";
import { app } from "./app";

const port = Number(env.READ_STATE_PORT);

void (async () => {
  await initializeCassandra();
  await startSubscriber();
  app.listen(port, () => {
    console.log(`Read-state service running on port ${port} (Cassandra keyspace=${env.READ_STATE_CASSANDRA_KEYSPACE})`);
  });
})();
