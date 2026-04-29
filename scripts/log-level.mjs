#!/usr/bin/env node
/**
 * Usage: node scripts/log-level.mjs <service|all> <level>
 *
 * Examples:
 *   node scripts/log-level.mjs dms debug
 *   node scripts/log-level.mjs all info
 *   node scripts/log-level.mjs realtime trace
 */
import { execSync } from "child_process";

const SERVICE_PORTS = {
  auth:         3001,
  communities:  3002,
  messages:     3003,
  search:       3004,
  realtime:     3005,
  dms:          3007,
  "read-state": 3008,
};

const SSH_HOST = "root@130.245.136.45";
const VALID_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"];
const VALID_SERVICES = [...Object.keys(SERVICE_PORTS), "all"];

const [,, serviceName, level] = process.argv;

if (!serviceName || !level) {
  console.error("Usage: node scripts/log-level.mjs <service|all> <level>");
  console.error(`  Services: ${VALID_SERVICES.join(", ")}`);
  console.error(`  Levels:   ${VALID_LEVELS.join(", ")}`);
  process.exit(1);
}
if (!VALID_LEVELS.includes(level)) {
  console.error(`Invalid level "${level}". Must be one of: ${VALID_LEVELS.join(", ")}`);
  process.exit(1);
}
if (!VALID_SERVICES.includes(serviceName)) {
  console.error(`Invalid service "${serviceName}". Must be one of: ${VALID_SERVICES.join(", ")}`);
  process.exit(1);
}

const targets = serviceName === "all"
  ? Object.entries(SERVICE_PORTS)
  : [[serviceName, SERVICE_PORTS[serviceName]]];

for (const [name, port] of targets) {
  const payload = JSON.stringify({ level });
  const cmd = `ssh ${SSH_HOST} "curl -sf -XPOST http://localhost:${port}/internal/log-level -H 'Content-Type: application/json' -d '${payload}'"`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    console.log(`${name.padEnd(12)} → ${result.trim()}`);
  } catch (err) {
    console.error(`${name.padEnd(12)} → FAILED: ${err.stderr?.trim() || err.message}`);
  }
}
