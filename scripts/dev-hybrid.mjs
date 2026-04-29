#!/usr/bin/env node
import { readFileSync } from "fs";
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const SERVICE_META = {
  auth:         { workspace: "auth-service",        port: 3001, viteVar: "VITE_AUTH_ORIGIN" },
  communities:  { workspace: "communities-service",  port: 3002, viteVar: "VITE_COMMUNITIES_ORIGIN" },
  messages:     { workspace: "messages-service",     port: 3003, viteVar: "VITE_MESSAGES_ORIGIN" },
  search:       { workspace: "search-service",       port: 3004, viteVar: "VITE_SEARCH_ORIGIN" },
  realtime:     { workspace: "realtime-service",     port: 3005, viteVar: "VITE_REALTIME_ORIGIN" },
  dms:          { workspace: "dms-service",          port: 3007, viteVar: "VITE_DMS_ORIGIN" },
  "read-state": { workspace: "read-state-service",   port: 3008, viteVar: "VITE_READ_STATE_ORIGIN" },
};

const STAGING_ORIGIN = "https://group-6.cse356.compas.cs.stonybrook.edu";

// Parse .local-services
const configPath = resolve(root, ".local-services");
const lines = readFileSync(configPath, "utf8").split("\n");
const localServices = new Set(
  lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
);

const unknownServices = [...localServices].filter((n) => !SERVICE_META[n]);
if (unknownServices.length > 0) {
  console.error(`[dev:hybrid] Unknown service(s) in .local-services: ${unknownServices.join(", ")}`);
  console.error(`[dev:hybrid] Valid names: ${Object.keys(SERVICE_META).join(", ")}`);
  process.exit(1);
}

if (localServices.size === 0) {
  console.log("No local services selected — running frontend only against staging. To run services locally, uncomment them in .local-services.");
} else {
  console.log("Local services:", [...localServices].join(", "));
}

// Build concurrently args
const names = [];
const colors = [];
const commands = [];

for (const [name, meta] of Object.entries(SERVICE_META)) {
  if (!localServices.has(name)) continue;
  names.push(name);
  colors.push("auto");
  commands.push(
    `cross-env ENV_FILE=.env.staging-infra-local npm run dev --workspace ${meta.workspace}`
  );
}

// Frontend — point local services at localhost, rest at staging
const viteEnv = Object.entries(SERVICE_META)
  .map(([name, meta]) => {
    const origin = localServices.has(name)
      ? `http://localhost:${meta.port}`
      : STAGING_ORIGIN;
    return `${meta.viteVar}=${origin}`;
  })
  .join(" ");

const localPorts = [...localServices].map((n) => SERVICE_META[n].port).join(" ");
names.push("frontend");
colors.push("auto");
commands.push(`node scripts/wait-for-services.mjs ${localPorts} && cross-env ${viteEnv} npm run dev --workspace frontend`);

// Add SSH tunnel as first process — delay-wrap services so the tunnel has
// time to establish before Node tries to connect to forwarded ports.
names.unshift("tunnel");
colors.unshift("gray");
commands.unshift(
  `ssh -L 6379:10.0.3.49:6379 -L 6380:10.0.3.49:6380 -L 6381:10.0.3.49:6381 -L 6382:10.0.3.49:6382 -L 6432:10.0.2.247:6432 -L 5433:10.0.2.247:5433 -L 9042:10.0.2.111:9042 root@130.245.136.45 -N`
);

// Wrap service commands (not tunnel, not frontend) with tunnel wait.
// Frontend waits for services instead via wait-for-services.mjs.
const frontendIdx = commands.length - 1;
for (let i = 1; i < commands.length; i++) {
  if (i === frontendIdx) continue;
  commands[i] = `node scripts/wait-for-tunnel.mjs && ${commands[i]}`;
}

// Build a single shell string — avoids the DEP0190 args+shell warning and
// works on Windows where npx needs shell resolution.
const quotedCommands = commands.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(" ");
const fullCmd = `npx concurrently -n "${names.join(",")}" -c "${colors.join(",")}" --kill-others-on-fail ${quotedCommands}`;

const child = spawn(fullCmd, { stdio: "inherit", shell: true, cwd: root });
child.on("exit", (code) => process.exit(code ?? 0));
