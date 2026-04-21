import cluster from "cluster";
import os from "os";

if (cluster.isPrimary) {
  const workers = os.cpus().length;
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on("exit", (_worker, code, signal) => {
    process.stderr.write(`communities worker exited (code=${code} signal=${signal}), restarting\n`);
    cluster.fork();
  });
} else {
  require("./index");
}
