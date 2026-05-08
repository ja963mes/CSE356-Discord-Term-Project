import cluster from "cluster";
import os from "os";

if (cluster.isPrimary) {
  // One worker per vCPU (no extra oversubscription). On a 4 vCPU / 8GB messages VM this yields 4 Node processes.
  const cpus = os.cpus().length;
  const workers = Math.max(1, cpus);
  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on("exit", (_worker, code, signal) => {
    process.stderr.write(`messages worker exited (code=${code} signal=${signal}), restarting\n`);
    cluster.fork();
  });
} else {
  require("./index");
}
