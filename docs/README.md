# Documentation index

Project documentation lives under **`docs/`** (except the root [`README.md`](../README.md), which is the main entry point for the repo).

| Document | Description |
|----------|-------------|
| [`branching.md`](./branching.md) | Git: PRs from `nick` → `main-dev`; syncing after merge |
| [`CLAUDE.md`](./CLAUDE.md) | Cursor / AI-oriented project guide: stack, monorepo layout, spec checklist, conventions, proxy map |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | What is implemented vs course expectations (auth, stubs, frontend) |
| [`DEV-27-Direct-conversations-dm-service-setup.md`](./DEV-27-Direct-conversations-dm-service-setup.md) | DM service (Cassandra, port 3007), endpoints, local setup |
| [`DEV-28-Channels-scaffold-communities-service.md`](./DEV-28-Channels-scaffold-communities-service.md) | Channels on communities service (migration 0006, APIs, follow-ups) |
| [`sharding-and-replication.md`](./sharding-and-replication.md) | Cassandra/Postgres sharding notes; future **per-domain search** (splintered by microservice) |
| [`STAGING-ROLLOUT.md`](./STAGING-ROLLOUT.md) | Staging runbook: full stack except search; systemd, nginx, migrations, smoke tests |
| [`ANSIBLE-SETUP.md`](./ANSIBLE-SETUP.md) | Lightweight Ansible scaffold for split frontend/backend VM deploys |
| [`nginx-linode-production-frontend.conf.example`](./nginx-linode-production-frontend.conf.example) | **Supported:** frontend VM — static `frontend/dist` + proxy API/WS to backend VM nginx ([`PROD-SPLIT-NGINX.md`](./PROD-SPLIT-NGINX.md)) |
| [`nginx-linode-production-backend.conf.example`](./nginx-linode-production-backend.conf.example) | **Supported:** backend VM — API/WS reverse proxy to local Node ports (404 for `/`) |
| Deprecated nginx examples (reference only) | [`nginx-linode-staging.conf.example`](./nginx-linode-staging.conf.example), [`nginx-linode-production.conf.example`](./nginx-linode-production.conf.example), [`nginx-linode-services-only.conf.example`](./nginx-linode-services-only.conf.example) — **do not use for new deployments**; use the frontend + backend pair above. |

---

The root [`CLAUDE.md`](../CLAUDE.md) file is a short pointer to [`docs/CLAUDE.md`](./CLAUDE.md) so tooling that expects a file at the repo root still resolves.
