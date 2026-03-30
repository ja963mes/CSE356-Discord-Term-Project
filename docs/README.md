# Documentation index

Project documentation lives under **`docs/`** (except the root [`README.md`](../README.md), which is the main entry point for the repo).

| Document | Description |
|----------|-------------|
| [`CLAUDE.md`](./CLAUDE.md) | Cursor / AI-oriented project guide: stack, monorepo layout, spec checklist, conventions, proxy map |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | What is implemented vs course expectations (auth, stubs, frontend) |
| [`DEV-27-Direct-conversations-dm-service-setup.md`](./DEV-27-Direct-conversations-dm-service-setup.md) | DM service (Cassandra, port 3007), endpoints, local setup |
| [`DEV-28-Channels-scaffold-communities-service.md`](./DEV-28-Channels-scaffold-communities-service.md) | Channels on communities service (migration 0006, APIs, follow-ups) |
| [`sharding-and-replication.md`](./sharding-and-replication.md) | Future-oriented notes on sharding by community, replication, and routing |

---

The root [`CLAUDE.md`](../CLAUDE.md) file is a short pointer to [`docs/CLAUDE.md`](./CLAUDE.md) so tooling that expects a file at the repo root still resolves.
