import net from "net";

const POLL_INTERVAL_MS = 1000;
// Poll the first forwarded Redis port — tunnel is up once this connects.
const HOST = "127.0.0.1";
const PORT = 6379;

function isReachable(host, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(500);
    sock.on("connect", () => { sock.destroy(); resolve(true); });
    sock.on("error", () => { sock.destroy(); resolve(false); });
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

console.log(`[dev:hybrid] waiting for SSH tunnel on localhost:${PORT}...`);
while (!(await isReachable(HOST, PORT))) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
console.log("[dev:hybrid] tunnel ready.");
