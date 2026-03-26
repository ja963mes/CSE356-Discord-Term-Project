# Join service (placeholder)

Future home for **joining** communities by invite code, directory, or deep link.

- **Communities you create** are capped at **100** per user (enforced in the communities service).
- **Joining** communities has **no cap**; that logic will live here or be orchestrated with the communities API.

This directory is reserved for scaffolding only; no HTTP server is wired up yet.

## Next (deferred)
- Implement a dedicated join endpoint (likely `POST /join`) that:
  - accepts either `{ communityId }` or `{ inviteCode }` (TBD),
  - verifies the current user session,
  - inserts into `community_members` (with role/defaults),
  - ensures membership constraints and returns the joined community.
