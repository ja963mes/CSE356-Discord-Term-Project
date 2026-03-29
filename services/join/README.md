# Join service (placeholder)

Future home for **joining** communities by invite code, directory, or deep link.

- **Communities you create** are capped at **100** per user (enforced in the communities service).
- **Joining** communities has **no cap**; that logic will live here or be orchestrated with the communities API.

This directory is reserved for scaffolding only; no HTTP server is wired up yet.

Directory **join-by-id** from the UI is implemented via the **communities** service: `POST /communities/:communityId/join`.

## Next (deferred)
- Optional: invite codes / deep links orchestrated here or calling into communities.
