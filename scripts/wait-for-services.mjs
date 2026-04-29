/**
 * Polls each local service's /health endpoint until all respond 200,
 * then exits so the frontend can start.
 * Usage: node scripts/wait-for-services.mjs 3007 3003 3005
 */
const ports = process.argv.slice(2).map(Number);
if (ports.length === 0) {
  console.log("[dev:hybrid] no services to wait for, starting frontend...");
  process.exit(0);
}

const POLL_INTERVAL_MS = 1000;

async function isReady(port) {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

console.log(`[dev:hybrid] waiting for services on ports: ${ports.join(", ")}...`);

while (true) {
  const results = await Promise.all(ports.map(isReady));
  const pending = ports.filter((_, i) => !results[i]);
  if (pending.length === 0) {
    console.log("[dev:hybrid] all services ready, starting frontend...");
    break;
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}
