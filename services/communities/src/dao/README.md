## DAO Pattern (Pilot)

This folder is the Postgres DAO pilot for `communities-service`.

- `communitiesDao.ts`: community directory/community table reads
- `communityMembersDao.ts`: membership checks + member listings
- `channelsDao.ts`: channel CRUD/query operations
- `channelMembersDao.ts`: channel membership operations
- `usersDao.ts`: user table lookups used by community flows

### Usage rules

- Route handlers orchestrate authz, cache invalidation, and event publish.
- DAOs own Drizzle query composition and DB reads/writes.
- DAOs do not return HTTP responses or touch Redis cache/event systems.

### Rollout template

When applying to other Postgres services, keep the same split:
table/domain DAOs for query logic, route/service layer for orchestration and side effects.
