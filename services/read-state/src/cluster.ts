import cluster from "cluster";

// READ_STATE_WORKERS > 1: primary handles Redis subscriber only, workers handle HTTP.
// Subscriber must run on exactly one process — incrementMentionCounts uses Cassandra
// counters (mention_count + N); multiple subscribers would multiply mention counts.
const WORKERS = parseInt(process.env.READ_STATE_WORKERS ?? "1", 10);

if (cluster.isPrimary && WORKERS > 1) {
  void (async () => {
    const { initializeCassandra } = await import("./cassandra");
    const { startSubscriber } = await import("./subscriber");
    await initializeCassandra();
    await startSubscriber();
    console.log(`[read-state] cluster primary: subscriber started, forking ${WORKERS} HTTP workers`);
    for (let i = 0; i < WORKERS; i++) {
      cluster.fork({ READ_STATE_SUBSCRIBER: "false" });
    }
    cluster.on("exit", (worker, code, signal) => {
      console.warn(`[read-state] worker ${worker.process.pid} exited (code=${code} signal=${signal}), restarting`);
      cluster.fork({ READ_STATE_SUBSCRIBER: "false" });
    });
  })();
} else {
  // Single-process mode (WORKERS=1) or cluster worker — run full index.
  // In worker mode READ_STATE_SUBSCRIBER=false so index.ts skips startSubscriber().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./index");
}
