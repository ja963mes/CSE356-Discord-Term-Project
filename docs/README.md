# Documentation index

Project documentation lives under **`docs/`** (except the root [`README.md`](../README.md), which is the main entry point for the repo).

| Document | Description |
|----------|-------------|
| [`CLAUDE.md`](./CLAUDE.md) | Cursor / AI-oriented project guide: stack, monorepo layout, spec checklist, conventions, proxy map |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | What is implemented vs course expectations (auth, stubs, frontend) |
| [`DEV-27-Direct-conversations-dm-service-setup.md`](./DEV-27-Direct-conversations-dm-service-setup.md) | DM service (Cassandra, port 3007), endpoints, local setup |
| [`DEV-28-Channels-scaffold-communities-service.md`](./DEV-28-Channels-scaffold-communities-service.md) | Channels on communities service (migration 0006, APIs, follow-ups) |
| [`sharding-and-replication.md`](./sharding-and-replication.md) | Future-oriented notes on sharding by community, replication, and routing |
| [`STAGING-ROLLOUT.md`](./STAGING-ROLLOUT.md) | Staging deployment order, migration notes, smoke tests, rollback checklist for auth/communities/messages/realtime |
| [`nginx-linode-staging.conf.example`](./nginx-linode-staging.conf.example) | Example Nginx reverse proxy (same path order as Vite; WebSocket `/ws`) |
| [`nginx-linode-services-only.conf.example`](./nginx-linode-services-only.conf.example) | Example Nginx reverse proxy for staging when only auth/communities/create-community/realtime are deployed |

---

The root [`CLAUDE.md`](../CLAUDE.md) file is a short pointer to [`docs/CLAUDE.md`](./CLAUDE.md) so tooling that expects a file at the repo root still resolves.
