# DEV-28 — Channels scaffold (communities service)

**Jira:** DEV-28  
**Spec area:** §4 Channels (within a community)

## Overview

Channel **metadata**, **public/private visibility**, and **`channel_members`** access control are implemented on the existing **communities** microservice (**port 3002**). There is **no** separate `channels` service at this time; the same PostgreSQL database and Drizzle migrations as auth are used.

---

## Architecture decision

- **Rationale:** `community_id` on `channels` is a data dependency, not a requirement for an extra process. Keeping channel APIs on **communities** reduces operational surface area; **messages** and **realtime** are separate services today (see root `README.md` / `IMPLEMENTATION.md`).
- **Future:** A dedicated channels service can be split out later if scaling or ownership boundaries require it; [CLAUDE.md](./CLAUDE.md) §4 records product rules and remaining cross-cutting work.

---

## Database

| Change | Detail |
|--------|--------|
| Migration | `services/auth/drizzle/0006_wealthy_thundra.sql` |
| `channels` | New column `is_private` (`boolean`, default `false`, not null) |
| `channel_members` | Composite PK `(channel_id, user_id)`, `joined_at`, FKs to `channels` and `users` |
| Backfill | Insert into `channel_members` for every pair `(public channel in community, community member)` |

Schema copies stay aligned in:

- `services/auth/src/db/schema.ts`
- `services/communities/src/db/schema.ts`
- `services/create-community/src/db/schema.ts`

**Apply locally:** `npm run db:migrate` (from repo root).

---

## create-community service

- After creating `#general`, inserts **`channel_members`** for the **creator** so the owner can read history immediately.
- Channel row includes `is_private: false`.

---

## Communities service — behaviour

| Area | Behaviour |
|------|-----------|
| **Join community** | After `community_members` insert, user is added to **`channel_members`** for every **public** channel in that guild. |
| **Leave community** | Deletes **`channel_members`** rows for that user on all channels belonging to the guild. |
| **Admin roles** | `community_members.role` in `{ owner, admin }` may create/update channels and add users to channels. |
| **List channels** | Community member only. Returns **public** channels + **private** channels where the user has a **`channel_members`** row. Each item includes `is_private` and **`joined`**. |

### HTTP API (all require session cookie except N/A)

| Method | Path | Notes |
|--------|------|--------|
| `GET` | `/communities/:communityId/channels` | Filtered list + `joined` |
| `POST` | `/communities/:communityId/channels` | Body: `name`, optional `type`, `is_private`, `position` |
| `PATCH` | `/communities/:communityId/channels/:channelId` | `name`, `is_private`, `position`; setting `is_private: false` adds all guild members to `channel_members` |
| `POST` | `/communities/:communityId/channels/:channelId/join` | **Public** channels only |
| `POST` | `/communities/:communityId/channels/:channelId/leave` | Remove self from `channel_members` (admins cannot leave private channels they manage) |
| `GET` | `/communities/:communityId/channels/:channelId/members` | Admin; list visibility members for **private** channels |
| `POST` | `/communities/:communityId/channels/:channelId/members` | Admin; body `{ "user_id" }` — target must be a community member (used for **private** channels) |
| `DELETE` | `/communities/:communityId/channels/:channelId/members/:userId` | Admin; remove user visibility from **private** channel (cannot remove self) |
| `DELETE` | `/communities/:communityId/channels/:channelId` | Admin; cannot delete the last channel in the community |

**Listing guilds:** `GET /communities` includes each row’s **`role`** (`owner` | `admin` | `member`) for the current user.

---

## Frontend

- `frontend/src/api/discord.ts` — **`Channel`** type extended with optional `position`, `is_private`, `joined`; includes `addChannelMember(...)` client for private-channel invites.
- `frontend/src/pages/ChatPage.tsx` — admin affordance opens a channel management modal for private channels.
- `frontend/src/components/CommunityModals.tsx` — `ManagePrivateChannelMembersModal` shows who has visibility and allows add/remove actions (Discord-like access management flow).

---

## Documentation updated

- `README.md` — Communities API table and migration note.
- [CLAUDE.md](./CLAUDE.md) — §4 status: done vs remaining (messages enforcement, optional UI, optional aggregate endpoint).

---

## Build verification (recorded DEV-28)

```bash
npm run build --workspace auth-service
npm run build --workspace communities-service
npm run build --workspace create-community-service
npm run build --workspace frontend
npm run build   # root: auth + frontend
```

All completed successfully on the integration branch before push.

---

## Not in scope for this ticket (follow-up)

1. **Messages service (§6):** ~~Authorize `channel_id` using **`channel_members`** before read/write~~ — **done** on `GET/POST /messages`; channel history is in **Cassandra** (`messages_by_channel`). Migration `0008_*` drops Postgres `channel_messages`. Remaining: WebSocket fan-out, edits, pagination UX polish.
2. **UI (partially done):** Create channel modal, delete channel (admin), join gate when `joined === false`, lock/private affordances, **send message** to channel, and add member to private channel from UI (`POST .../members`). **Still missing:** promote member to `admin`, private “request access”.
3. **Optional:** `GET .../channels-overview?include=recent` once message history APIs exist.
4. **Optional:** promote member to `admin` via API, private-channel “request access”.

---

## Related

- **DEV-27:** [DEV-27-Direct-conversations-dm-service-setup.md](./DEV-27-Direct-conversations-dm-service-setup.md) (DMs on Cassandra, port 3007).
