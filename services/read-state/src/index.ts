import { env } from "./env";
import { initializeCassandra } from "./cassandra";
import { startSubscriber } from "./subscriber";
import { app } from "./app";

const port = Number(env.READ_STATE_PORT);

void (async () => {
  await initializeCassandra();
  await startSubscriber();
  const server = app.listen(port, () => {
    console.log(`Read-state service running on port ${port} (Cassandra keyspace=${env.READ_STATE_CASSANDRA_KEYSPACE})`);
  });
  // keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
  // Prevents ERR_INCOMPLETE_CHUNKED_ENCODING when nginx reuses a socket Node just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
})();
