# Team Process and Contributions

CSE 356, Stony Brook University. Group 6 — Discord-style messaging system.

> **Action required before submission:** each member should review and edit their own subsection below to make sure responsibilities, contributions, and tasks are accurate. Areas marked _[fill in]_ are placeholders.

---

## Members

### Nicholas Gitman (`ngitman` / `nicholasgitman@gmail.com`)

- **Main responsibilities:** Realtime service (WebSocket fan-out, presence, instance registry), Redis topology and scaling, monitoring (Zabbix), deploy automation (Ansible).
- **Major contributions:**
  - Designed and shipped the four-instance Redis split (`pubsub`, `pubsub2`, `kv`, `kv2`) and the per-port `maxmemory` / eviction policy choices.
  - Diagnosed the SMEMBERS hot-key bottleneck on `kv2` (320k calls / 366 µs avg, 1521-member set) and shipped the in-memory TTL cache + inflight dedupe in `services/realtime/src/index.ts`.
  - Replaced `SCAN MATCH presence:conns:*` with the maintained `presence:conns:index` set in `services/realtime/src/presence.ts`; reaper now self-heals empty hashes.
  - Scaled the Redis VM 4 vCPU → 8 vCPU and reserved capacity for future per-workload splits.
  - Wired Zabbix agent2's built-in Redis plugin per port + per-port process-liveness UserParameter; documented server-side trigger setup in `docs/zabbix-redis-monitoring.md`.
  - Maintained the Ansible playbook (`ansible/playbooks/site.yml`) and inventory.
- **Leadership / coordination:** Drove the load-test → measure → fix → re-measure loop on the Redis bottleneck. Wrote scaling and architecture documentation.

### James Barrera (`ja963mes` / `james.barrera@stonybrook.edu`)

- **Main responsibilities:** _[fill in — typical: communities/channels service, frontend, local dev tooling]_
- **Major contributions:**
  - Local dev tooling: `npm run dev:*:staging` scripts, `sshuttle` hybrid mode, runtime log-level commands.
  - _[fill in additional contributions]_
- **Leadership / coordination:** _[fill in]_

### Robert Wong (`robw0ng` / `robwong15@gmail.com`)

- **Main responsibilities:** _[fill in — typical: messages service, Cassandra schema, attachments]_
- **Major contributions:** _[fill in]_
- **Leadership / coordination:** _[fill in]_

### Yuchen Lin (`PunchyCandy` / `linyuchen12345@gmail.com`)

- **Main responsibilities:** _[fill in — typical: search service, Elasticsearch indexing, frontend]_
- **Major contributions:** _[fill in]_
- **Leadership / coordination:** _[fill in]_

---

## Communication

- **Day-to-day chat:** Discord. We ran our own server with text channels for design discussion, blockers, code-review pings, and voice channels for pair debugging.
- **Service-down alerts:** initially a GitHub-Actions / Uptime Kuma → Discord webhook that pinged the channel whenever a `/health` endpoint stopped responding. Later replaced by Zabbix triggers (per-service systemd liveness, per-port Redis health, per-VM CPU/memory) routing into the same Discord channel — so one alerting surface covered both app health and infra-level saturation. See `docs/zabbix-redis-monitoring.md` for the Redis trigger set.
- **Sync meetings:** weekly standup over Discord voice + ad-hoc pair-debugging sessions during load-test sprints.
- **Code review:** every change went through a GitHub PR into `main-dev`. At least one teammate review before merge; CI auto-deploys to staging on merge (`.github/workflows/deploy-staging.yml`).

## Work division

Each member owned one or more services end-to-end (schema → API → frontend integration → deploy → tests). Cross-cutting work — Redis topology, Ansible, monitoring, scaling — was claimed and reviewed in the team chat to avoid stepping on each other.

When a feature spanned services (e.g. DM delivery reliability touched `dms`, `realtime`, and `read-state`), one member acted as the lead for the change and others reviewed the boundary contracts.

## Progress tracking

- **GitHub issues + PRs.** PR titles followed `feat: ...` / `fix: ...` / `perf: ...` / `docs: ...` so the merge log doubles as a change log (`git log --oneline main..nick`).
- **Branching model.** Feature branches → `nick` (integration) → `main-dev` (auto-deploy to staging) → `main` (release). Documented in `docs/branching.md`.
- **Staging-driven verification.** Every non-trivial change was verified on staging against the autograder before declaring done.

## Deadline handling

- We worked backwards from each course milestone, checkpoint-tested on staging, and kept the `main-dev` branch always-deployable so a teammate could ship at any time.
- Load-test results drove the prioritisation: when the autograder reported `Delivery timeout`, that became the next sprint's headline regardless of what was originally planned for the week.
- Documentation was written alongside the work, not at the end — the per-decision Ansible/Zabbix docs and `docs/SCALING.md` were updated as fixes landed.
