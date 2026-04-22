import cluster from "cluster";
import os from "os";
import { logger } from "./logger";

// WORKERS env var lets systemd-managed deployments set this to 1 (default)
// since multiple instances are already managed as separate systemd units.
// Only set REALTIME_WORKERS > 1 if running a single systemd unit on the host.
const WORKERS = parseInt(process.env.REALTIME_WORKERS ?? "1", 10);

if (cluster.isPrimary && WORKERS > 1) {
  logger.info({ workers: WORKERS }, "realtime cluster primary starting");
  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }
  cluster.on("exit", (worker, code, signal) => {
    logger.warn({ pid: worker.process.pid, code, signal }, "realtime worker exited; restarting");
    cluster.fork();
  });
} else {
  // Single-process mode (default) or worker process
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./index");
}
