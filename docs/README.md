# Documentation

Everything below lives in **`docs/`** except the root **[README.md](../README.md)** (clone, scripts, architecture overview).

---

## Start here

| Document | Description |
|----------|-------------|
| **[../README.md](../README.md)** | Top-level project README — covers the six required sections (Overview, Running, Scaling, Design, Developer Guide, Team) |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Topology, service boundaries, pub-sub event shapes, failure modes |
| **[SCALING.md](./SCALING.md)** | Bottleneck-by-bottleneck analysis with `redis-cli` evidence and fixes |
| **[../TEAM.md](../TEAM.md)** | Team reflection, member contributions, process |
| **[IMPLEMENTATION.md](./IMPLEMENTATION.md)** | What is implemented vs typical expectations (services, data stores, nginx, tooling) |
| **[zabbix-redis-monitoring.md](./zabbix-redis-monitoring.md)** | Per-port Redis monitoring (agent2 + Zabbix server triggers) |
| **[CLAUDE.md](./CLAUDE.md)** | Editor / AI guide: stack, layout, proxy map, conventions, spec backlog |
| **[branching.md](./branching.md)** | Git: `nick` → `main-dev`, staying up to date |

---

## Deploy & operations

| Document | Description |
|----------|-------------|
| **[STAGING-ROLLOUT.md](./STAGING-ROLLOUT.md)** | Staging VM: services, systemd, nginx, migrations, smoke checks |
| **[ROLLBACK.md](./ROLLBACK.md)** | How to rollback to a previous commit/tag via workflow_dispatch |
| **[PROD-SPLIT-NGINX.md](./PROD-SPLIT-NGINX.md)** | **Production:** split nginx with frontend + backend, plus direct `/auth` to auth-service over private network |
| **[nginx/README.md](./nginx/README.md)** | Centralized nginx configs index |
| **[nginx/production-frontend.conf.example](./nginx/production-frontend.conf.example)** | **Supported** frontend VM site config |
| **[nginx/production-backend.conf.example](./nginx/production-backend.conf.example)** | **Supported** backend VM site config |
| **[nginx/production-search.conf.example](./nginx/production-search.conf.example)** | **Supported** dedicated search ingress config (`/search`, `/directory`) |
| **[ANSIBLE-SETUP.md](./ANSIBLE-SETUP.md)** | Ansible scaffold for split-VM deploy (`ansible/`) |

**Deprecated (reference only — do not use for new installs):**  
[nginx/deprecated/linode-staging.conf.example](./nginx/deprecated/linode-staging.conf.example), [nginx/deprecated/linode-production-combined.conf.example](./nginx/deprecated/linode-production-combined.conf.example), [nginx/deprecated/linode-services-only.conf.example](./nginx/deprecated/linode-services-only.conf.example) — superseded by the frontend + backend pair above ([§7 in PROD-SPLIT-NGINX](./PROD-SPLIT-NGINX.md)).

---

## Features & deep dives

| Document | Description |
|----------|-------------|
| **[DEV-27-Direct-conversations-dm-service-setup.md](./DEV-27-Direct-conversations-dm-service-setup.md)** | DM service (`/dms`), Cassandra, port 3007 |
| **[DEV-28-Channels-scaffold-communities-service.md](./DEV-28-Channels-scaffold-communities-service.md)** | Channels on communities service (migration 0006, APIs) |
| **[sharding-and-replication.md](./sharding-and-replication.md)** | Cassandra message partitioning; future Postgres / search notes |

---

## Tooling in-repo

| Path | Description |
|------|-------------|
| **[../k6/](../k6/)** | k6 latency smoke tests; `npm run k6:routes` / `npm run k6:search-messages` |
| **[../ansible/README.md](../ansible/README.md)** | Ansible quick start |

---

## Root pointers

- **[../CLAUDE.md](../CLAUDE.md)** — short link into **`docs/CLAUDE.md`** for tools that expect a repo-root file.
