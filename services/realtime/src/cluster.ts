import cluster from "cluster";
import os from "os";
import { logger } from "./logger";

const WORKERS = os.cpus().length;

if (cluster.isPrimary) {
  logger.info({ workers: WORKERS }, "realtime cluster primary starting");
  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }
  cluster.on("exit", (worker, code, signal) => {
    logger.warn({ pid: worker.process.pid, code, signal }, "realtime worker exited; restarting");
    cluster.fork();
  });
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./index");
}
