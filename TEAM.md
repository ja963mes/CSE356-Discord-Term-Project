# Team Process and Contributions

CSE 356, Stony Brook University. Group 6 — Discord-style messaging system.

> **Action required before submission:** each member should review and edit their own subsection below to make sure responsibilities, contributions, and tasks are accurate. Areas marked _[fill in]_ are placeholders.

---

## Members

### Nicholas Gitman (`ngitman` / `nicholasgitman@gmail.com`)

- **Main responsibilities:** Realtime service (WebSocket fan-out, presence, instance registry), Redis topology and scaling, read-state service, search service, communities/channels, monitoring (Zabbix), CI/CD and deploy automation (Ansible + GitHub Actions), nginx + multi-VM infrastructure.
- **Major contributions:**
  - **Redis topology.** Designed and shipped the four-instance Redis split (`pubsub`, `pubsub2`, `kv`, `kv2`) with per-port `maxmemory` / eviction policy; scaled the Redis VM 4 vCPU → 8 vCPU.
  - **Realtime fan-out perf.** Diagnosed the SMEMBERS hot-key bottleneck on `kv2` (320k calls / 366 µs avg, 1521-member set) and shipped the in-memory TTL cache + inflight dedupe in `services/realtime/src/index.ts`.
  - **Presence index.** Replaced `SCAN MATCH presence:conns:*` with the maintained `presence:conns:index` set in `services/realtime/src/presence.ts`; reaper self-heals empty hashes; TTL on `presence:away` to cap growth.
  - **DM delivery reliability.** Direct HTTP fanout between `dms` and `realtime` to cut the live-delivery race, outbound pending-dm queue for live fanout misses, Cassandra catch-up path gated on offline marker, dead-instance eviction from registry.
  - **Read-state service.** Scaled out to its own VM (10.0.1.189), added Redis cache to cut Cassandra reads ~70%, batched channel-state reads via MGET, cached `assertChannelAccess` in Redis.
  - **Search service.** Replaced Postgres trigram directory search with Elasticsearch for community directory; centralized pubsub publishers + shard math through `@discord/pubsub` workspace; subscribed search to `channel:events` and `dm:events`.
  - **Communities + channels.** Built the communities/guilds stack (DB migration, services, chat UI), private channel ACLs + invite UI, Cassandra-backed channel history migration, Redis read cache for hot GET endpoints.
  - **Monitoring.** Wired Zabbix agent2's built-in Redis plugin per port + per-port process-liveness UserParameter; documented server-side trigger setup in `docs/zabbix-redis-monitoring.md`.
  - **CI/CD + Ansible.** Set up GitHub Actions SSH deploys to staging on `main-dev`, dedicated workflow for `zabbix-agent` deploys, skip-CI on docs-only changes; built and maintained the Ansible playbook (`ansible/playbooks/site.yml`), inventory, per-VM nginx configs, dms / realtime / read-state VM roles.
  - **Auth + Postgres.** PgBouncer for connection pooling, fixed Postgres connection exhaustion under load, Drizzle migration runner via ts-node + journal stamping for DBs predating `__drizzle_migrations`, 409 on username unique race.
  - **Observability.** Added Pino structured logging across communities/auth/messages, per-stage timing for the channel-message delivery path, WS server heartbeat to prevent idle disconnects.
  - **Frontend hardening.** Stopped the channel read/fetch loop hitting `ERR_INSUFFICIENT_RESOURCES`; guarded `.slice`/displayName paths to prevent crashes on undefined values.
  - **Project docs.** Modernized README, ARCHITECTURE, SCALING, TEAM, branching workflow, staging rollout runbook.
- **Leadership / coordination:** Drove the load-test → measure → fix → re-measure loop on the Redis and read-state bottlenecks. Owned the deploy + CI pipeline so any teammate could ship to staging. Wrote scaling, architecture, and branching documentation.

### James Barrera (`ja963mes` / `james.barrera@stonybrook.edu`)

- **Main responsibilities:** 
  - Main responsibilities: Auth service, DM service, Message service, Real-time infrastructure (VMs 1–4), Cassandra cluster, Performance engineering, Scaling
- **Major contributions:**
  - wrote the initial auth service (local + OAuth login, session middleware, Drizzle ORM schema) and the DM Postgres schema  (direct_conversations, dm_participants, dm_messages)
  - Built and scaled the real-time layer — identified and fixed the primary O(n) WebSocket fanout bug where every Redis pub/sub event scanned all ~9,000 accumulated connections.
  - Refactored presence to O(1) pipelined MGET reads, added a 2s in-process cache with inflight deduplication on getPresenceTargets, and removed an idle sweep loop — each step measured and confirmed against production.
  - Spun up and configured real-time VM 2, added them to the nginx upstream, and tuned worker_connections per VM — enabling horizontal load splitting as traffic grew.
  - Operated and maintained the Cassandra cluster — tracked down the Cassandra split-brain issue, fixed DM message drops by adding a Cassandra catch-up path in the realtime service.

- **Leadership / coordination:** 
  - Identified, investigated, and documented major production bottlenecks presented findings to the team before implementing fixes. Monitored production during load tests and outages.


### Robert Wong (`robw0ng` / `robwong15@gmail.com`)

- **Main responsibilities:** Messages service (channel messages + attachments), DM delivery reliability under load, CI/CD pipeline, Ansible env handling, presence (initial build), read-state hardening.
- **Major contributions:**
  - **Messages + attachments.** Built channel-message edit/delete/real-time delivery, MinIO presigned-URL attachments for channels + DMs, added Elasticsearch + MinIO to docker compose, frontend for messages, attachment race-condition fix, MinIO CORS + crash hardening.
  - **DM delivery under load.** Headline fix that eliminated `Delivery timeout`: sharded DM pub-sub across 20 user-feed channels, per-socket outbound queue with backpressure kill, synchronous dead-socket eviction, timestamp-based Cassandra replay on reconnect, server-side dedup, Redis publish retries.
  - **Presence (initial build).** Wrote the first presence pipeline — activity detection, broadcast, viewable own + other-user presence, AUTH ↔ realtime decoupling so presence didn't block auth.
  - **DM metadata migration.** Moved DM conversation metadata from Cassandra to Postgres (DEV-31) for relational lookups + tests.
  - **CI/CD.** Added targeted-deploy workflow with concurrent-deploy cancellation, deploy summary, post-deploy health checks, retry-on-health-check, and rollback support.
  - **Ansible env handling.** Built the env-sync playbook and per-VM env templating for auth / Redis / Postgres / realtime-2.
  - **Cluster mode.** Clustered auth, communities, and messages to one worker per core.
  - **Read-state hardening.** Scaled up read-state workers, wrapped async handlers in try/catch, fixed invalid-timeuuid process crash, added communities batching + index + pool tweaks for speed.
  - **Dev workflow + logging.** Structured-logging refactor, hybrid dev workflow (one service local, rest on staging), test-harness overhaul, local-dev-against-staging docs.
- **Leadership / coordination:** Owned the messages + attachments stack end-to-end and the deploy pipeline — kept staging shippable and recoverable while the rest of the team iterated on perf fixes.

### Yuchen Lin (`PunchyCandy` / `linyuchen12345@gmail.com`)

- **Main responsibilities:** Read-state service, Zabbix monitoring stack, realtime delivery instrumentation, observability tooling.
- **Major contributions:**
  - **Read-state service.** Built the initial `read-state` microservice covering channel + DM read tracking, unread counts, and DM read receipts.
  - **Zabbix monitoring stack.** Added the Zabbix server + agent deploy role, host bootstrap script, log-based delivery monitoring, and agent-interface requirements; iterated on the Ansible role for older versions and fixed group_vars override layout.
  - **Realtime + DM diagnostics.** Added DM delivery trace instrumentation and Prometheus metrics for `realtime` and `dms`; wrote a closing-socket race repro script and shipped the closing-socket eviction fix on send.
  - **Observability polish.** Reduced realtime fan-out log volume to keep journald tractable under load; carried forward nginx group_var changes during the Ansible refactor.
- **Leadership / coordination:** Owned the team's monitoring surface end-to-end (Zabbix triggers, Prometheus metrics, delivery traces) so other members could see what their fixes were actually doing under load.

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
- **Staging-driven verification.** Every non-trivial change was verified on staging against the load generator before declaring done.

## Deadline handling

- We worked backwards from each course milestone, checkpoint-tested on staging, and kept the `main-dev` branch always-deployable so a teammate could ship at any time.
- Load-test results drove the prioritisation: when the load generator reported `Delivery timeout`, that became the next sprint's headline regardless of what was originally planned for the week.
- Documentation was written alongside the work, not at the end — the per-decision Ansible/Zabbix docs and `docs/SCALING.md` were updated as fixes landed.
