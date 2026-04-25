# Testing Guide

All test scripts live under `scripts/`. Requires Node 18+ and `ws` installed globally (`npm install -g ws`).

---

## API Test Suite

Runs a full end-to-end correctness check against every major endpoint. Sequential, pass/fail per assertion.

```bash
node scripts/api-test.mjs https://group-6.cse356.compas.cs.stonybrook.edu
```

**Covers:**

| Section | What's tested |
|---------|--------------|
| Auth | register, GET /auth/me, PATCH /auth/profile, logout, login, wrong password |
| Communities | create, list, join, leave, members |
| Channels | list (with seeded #general), create public, create private |
| Channel messages | send, get history, WS delivery (`channel:message:create`), edit, delete |
| DMs | 1:1 create (idempotent), list, send, get history, WS delivery (`dm:message:create`), edit, delete, group DM, add/leave participant |
| Read state | GET /read-state/dms, POST mark-read |
| Search | message search (waits 2s for ES indexing), community directory |
| Presence WS | `presence_update` snapshot on connect |

Exits non-zero if any assertion fails.

---

## Load Tests

### Individual scripts

Each script sets up its own users/data, runs for `--dur` seconds, and prints a per-endpoint summary with ok/fail counts and p50/p99 latency.

| Script | What it tests | Default RPS |
|--------|--------------|-------------|
| `scripts/load/dm.mjs` | DM send + `dm:message:create` WS delivery | 200 |
| `scripts/load/channel.mjs` | Channel send + `channel:message:create` WS delivery | 200 |
| `scripts/load/auth.mjs` | Register + login throughput | 50 |
| `scripts/load/rest.mjs` | GET /communities, /channels, /messages, /dms/:id/messages | 100 |
| `scripts/load/search.mjs` | GET /search/messages + /search-communities | 30 |

**Common flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--rps N` | varies | Target requests per second |
| `--pairs N` | 20 | Concurrent sender/receiver WS pairs (dm + channel only) |
| `--concurrency N` | varies | Concurrent workers (auth, rest, search) |
| `--dur N` | 15 | Test duration in seconds |
| `--timeout N` | 5000 | WS delivery timeout in ms (dm + channel only) |

**Examples:**

```bash
# DM delivery at default settings
node scripts/load/dm.mjs https://group-6.cse356.compas.cs.stonybrook.edu

# Channel delivery, longer run
node scripts/load/channel.mjs https://group-6.cse356.compas.cs.stonybrook.edu --dur 30

# Auth at higher concurrency
node scripts/load/auth.mjs https://group-6.cse356.compas.cs.stonybrook.edu --rps 100 --concurrency 20
```

### Run all in parallel (orchestrator)

Spawns all 5 load tests simultaneously to simulate realistic combined load. Identifies which services buckle first.

```bash
node scripts/load/run-all.mjs https://group-6.cse356.compas.cs.stonybrook.edu
```

Flags:
- `--dur N` — duration per test (default 15s)
- `--quick` — shorthand for `--dur 10`

Output shows pass/fail per test and lists pain points (failed tests) at the bottom.

---

## Trace Test

Runs channel + DM delivery rounds sequentially until a failure. On failure, SSHs into the relevant VMs and fetches logs automatically.

```bash
node scripts/trace-test.mjs https://group-6.cse356.compas.cs.stonybrook.edu --key ~/.ssh/id_ed25519
```

Add `$env:WS_DEBUG=1;` (PowerShell) before the command to print all raw WS events.

Requires SSH access to the jump host (`130.245.136.45`). The jump host must have its own keys to reach the internal VMs.

---

## Notes

- **WS delivery tests** pre-register the listener by message content *before* sending the HTTP request. This matches the grader's behavior and avoids the race where the WS event arrives before the listener is registered.
- **Channel load test** waits for `presence_update` (own presence) before sending messages. The server sends this only after `subscribeUser` completes, so `presence:channel:*` Redis sets are guaranteed populated. This matches `RealtimeManager.enable()` behavior in the grader client.
- **Search tests** wait 2–3 seconds after writing messages for Elasticsearch to index them before querying.
