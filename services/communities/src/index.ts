/// <reference path="./types/express.d.ts" />
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { env } from "./env";
import { requireAuth } from "./middleware/session";
import { publishCommunityEvent } from "./events";
import { httpLogger, logger, logRouteError } from "./logger";
import * as communitiesDao from "./dao/communitiesDao";
import * as communityMembersDao from "./dao/communityMembersDao";
import * as channelsDao from "./dao/channelsDao";
import * as channelMembersDao from "./dao/channelMembersDao";
import * as usersDao from "./dao/usersDao";
import {
  bumpAfterCommunityCreate,
  bumpAllForUserCommunity,
  bumpCommunityEpochs,
  cacheTtl,
  channelsCacheKey,
  getCachedJson,
  getCommunityChEpoch,
  getCommunityMemEpoch,
  getUserCommunityEpoch,
  membersCacheKey,
  getDirectorySearchEpoch,
  searchCacheKey,
  setCachedJson,
  userCommunitiesCacheKey,
} from "./readCache";

const MAX_COMMUNITIES_PER_USER = 100;
const MAX_COMMUNITY_NAME_LENGTH = 100;

function isCommunityAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function addUserToAllPublicChannels(communityId: string, userId: string): Promise<void> {
  const publicChannelIds = await channelsDao.listPublicIdsByCommunity(communityId);
  await channelMembersDao.addUserToChannels(userId, publicChannelIds);
}

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(httpLogger);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "communities-service" });
});

/**
 * Public directory search (no membership filter): Redis cache + **search-service** / Elasticsearch.
 * Query: q (required for results), limit (optional, default 25, max 100).
 */
app.get("/search-communities", async (req, res) => {
  const qRaw = String(req.query.q ?? "");
  const q = qRaw.trim().replace(/\s+/g, " ");
  const limitRaw = req.query.limit;
  const limit = Math.min(Number(limitRaw ?? 25) || 25, 100);

  if (!q) {
    res.json({ query: "", communities: [] as Array<{ id: string; name: string; created_at: string }> });
    return;
  }

  try {
    const epoch = await getDirectorySearchEpoch();
    const ck = searchCacheKey(epoch, q, limit);
    const hit = await getCachedJson<{ query: string; communities: Array<{ id: string; name: string; created_at: string }> }>(
      ck,
    );
    if (hit) {
      res.json(hit);
      return;
    }

    const base = env.SEARCH_SERVICE_URL.replace(/\/+$/, "");
    const url = new URL(`${base}/directory/communities`);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", String(limit));

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    let fetchRes: Awaited<ReturnType<typeof fetch>>;
    try {
      fetchRes = await fetch(url.toString(), { signal: ctrl.signal, headers: { Accept: "application/json" } });
    } finally {
      clearTimeout(t);
    }

    if (!fetchRes.ok) {
      logRouteError("GET /search-communities search-service error", new Error(`HTTP ${fetchRes.status}`), {
        reqId: req.id,
        q,
        url: url.toString(),
      });
      res.status(502).json({ error: "Directory search temporarily unavailable" });
      return;
    }

    const payload = (await fetchRes.json()) as {
      query: string;
      communities: Array<{ id: string; name: string; created_at: string }>;
    };
    void setCachedJson(ck, cacheTtl.search, payload);
    res.json(payload);
  } catch (e) {
    logRouteError("GET /search-communities failed", e, { reqId: req.id, q });
    res.status(500).json({ error: "Failed to search communities" });
  }
});

/** Create a community (caps at 100/user, seeds #general, owner membership). */
app.post("/create-community", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (name.length > MAX_COMMUNITY_NAME_LENGTH) {
    res.status(400).json({ error: `name must be ${MAX_COMMUNITY_NAME_LENGTH} characters or fewer` });
    return;
  }

  try {
    const result = await communitiesDao.createWithOwnerAndGeneralChannel(
      userId,
      name,
      MAX_COMMUNITIES_PER_USER,
    );
    if (!result.ok) {
      res.status(403).json({ error: `You can create at most ${MAX_COMMUNITIES_PER_USER} communities` });
      return;
    }

    const createdAtIso = result.created_at.toISOString();

    void bumpAfterCommunityCreate(userId, result.id);
    void publishCommunityEvent({
      type: "community:directory:upsert",
      communityId: result.id,
      name: result.name,
      created_at: createdAtIso,
    });

    res.status(201).json({
      community: {
        id: result.id,
        name: result.name,
        created_at: createdAtIso,
        role: "owner" as const,
      },
    });
  } catch (e) {
    logRouteError("POST /create-community failed", e, { reqId: req.id, userId });
    res.status(500).json({ error: "Failed to create community" });
  }
});

/** List communities the current user belongs to. */
app.get("/communities", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  try {
    const epoch = await getUserCommunityEpoch(userId);
    const ck = userCommunitiesCacheKey(userId, epoch);
    const hit = await getCachedJson<{
      communities: Array<{ id: string; name: string; created_at: string; role: string }>;
    }>(ck);
    if (hit) {
      res.json(hit);
      return;
    }

    const rows = await communitiesDao.listForUser(userId);

    const payload = { communities: rows };
    void setCachedJson(ck, cacheTtl.userCommunities, payload);
    res.json(payload);
  } catch (e) {
    logRouteError("GET /communities failed", e, { reqId: req.id, userId });
    res.status(500).json({ error: "Failed to list communities" });
  }
});

/** Join a community (open join for any authenticated user). */
app.post("/communities/:communityId/join", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const exists = await communitiesDao.existsById(communityId);
    if (!exists) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    const existingMembership = await communityMembersDao.getMembership(communityId, userId);
    if (existingMembership) {
      res.status(200).json({ message: "Already a member" });
      return;
    }

    const { joined_at: joinedAt, inserted } = await communityMembersDao.addMember(communityId, userId, "member");

    if (!inserted) {
      // Idempotent: heals rare partial state if another request inserted membership then failed mid-join.
      await addUserToAllPublicChannels(communityId, userId);
      res.status(200).json({ message: "Already a member" });
      return;
    }

    await addUserToAllPublicChannels(communityId, userId);

    const userRow = await usersDao.getUsernameAndProfileById(userId);
    const profile = (userRow?.profile as { displayName?: string } | null) ?? {};
    void publishCommunityEvent({
      type: "community:member:join",
      communityId,
      userId,
      username: userRow?.username ?? "",
      displayName: profile.displayName ?? userRow?.username ?? "",
      role: "member",
      joinedAt: joinedAt.toISOString(),
    });

    void bumpAllForUserCommunity(userId, communityId);

    res.status(201).json({ message: "Joined community" });
  } catch (e) {
    logRouteError("POST /communities/:communityId/join failed", e, { reqId: req.id, userId, communityId });
    res.status(500).json({ error: "Failed to join community" });
  }
});

/** Leave a community (removes membership row). */
app.post("/communities/:communityId/leave", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const exists = await communitiesDao.existsById(communityId);
    if (!exists) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    const removedMembership = await communityMembersDao.removeMember(communityId, userId);
    if (!removedMembership) {
      res.status(404).json({ error: "Not a member of this community" });
      return;
    }

    const channelIds = await channelsDao.listIdsByCommunity(communityId);
    await channelMembersDao.removeUserFromChannels(userId, channelIds);

    void publishCommunityEvent({
      type: "community:member:leave",
      communityId,
      userId,
    });

    void bumpAllForUserCommunity(userId, communityId);

    res.json({ message: "Left community" });
  } catch (e) {
    logRouteError("POST /communities/:communityId/leave failed", e, { reqId: req.id, userId, communityId });
    res.status(500).json({ error: "Failed to leave community" });
  }
});

/** Channels in a community (must be a member). */
app.get("/communities/:communityId/channels", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const chEpoch = await getCommunityChEpoch(communityId);
    const ck = channelsCacheKey(communityId, userId, chEpoch);
    const hit = await getCachedJson<{
      channels: Array<{
        id: string;
        name: string;
        type: string;
        position: number;
        is_private: boolean;
        joined: boolean;
      }>;
    }>(ck);
    if (hit) {
      res.json(hit);
      return;
    }

    const channelsOut = await channelsDao.listVisibleForUser(communityId, userId);

    const payload = { channels: channelsOut };
    void setCachedJson(ck, cacheTtl.channels, payload);
    res.json(payload);
  } catch (e) {
    logRouteError("GET /communities/:communityId/channels failed", e, { reqId: req.id, userId, communityId });
    res.status(500).json({ error: "Failed to list channels" });
  }
});

/** Members with display names and roles. */
app.get("/communities/:communityId/members", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const memEpoch = await getCommunityMemEpoch(communityId);
    const mk = membersCacheKey(communityId, memEpoch);
    const memHit = await getCachedJson<{
      members: Array<{
        user_id: string;
        username: string;
        display_name: string;
        role: string;
        joined_at: string;
      }>;
    }>(mk);
    if (memHit) {
      res.json(memHit);
      return;
    }

    const members = await communityMembersDao.listMembersWithProfiles(communityId);

    const memPayload = { members };
    void setCachedJson(mk, cacheTtl.members, memPayload);
    res.json(memPayload);
  } catch (e) {
    logRouteError("GET /communities/:communityId/members failed", e, { reqId: req.id, userId, communityId });
    res.status(500).json({ error: "Failed to list members" });
  }
});

/** Create a channel (community owner or admin only). */
app.post("/communities/:communityId/channels", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const type = typeof req.body?.type === "string" && req.body.type ? String(req.body.type) : "text";
  const isPrivate = Boolean(req.body?.is_private);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }
    if (!isCommunityAdminRole(membership.role)) {
      res.status(403).json({ error: "Only community administrators can create channels" });
      return;
    }

    const maxPosition = await channelsDao.getMaxPosition(communityId);
    const nextPosition =
      typeof req.body?.position === "number" && Number.isFinite(req.body.position)
        ? Math.trunc(req.body.position)
        : maxPosition + 1;

    const created = await channelsDao.createChannel({
      communityId,
      name,
      type,
      position: nextPosition,
      isPrivate,
    });

    if (isPrivate) {
      await channelMembersDao.addMember(created.id, userId);
    } else {
      const memberIds = await communityMembersDao.listUserIdsByCommunity(communityId);
      await channelMembersDao.addMembers(created.id, memberIds);
    }

    await publishCommunityEvent({
      type: "community:channel:create",
      communityId,
      channel: {
        id: created.id,
        name: created.name,
        type: created.type,
        position: created.position,
        is_private: created.is_private,
      },
    });

    void bumpCommunityEpochs(communityId, { ch: true });

    res.status(201).json({ channel: created });
  } catch (e) {
    logRouteError("POST /communities/:communityId/channels failed", e, { reqId: req.id, userId, communityId });
    res.status(500).json({ error: "Failed to create channel" });
  }
});

/** Update channel metadata or visibility (owner/admin only). */
app.patch("/communities/:communityId/channels/:channelId", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership || !isCommunityAdminRole(membership.role)) {
      res.status(403).json({ error: "Only community administrators can update channels" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const updates: { name?: string; is_private?: boolean; position?: number } = {};
    if (typeof req.body?.name === "string") {
      const n = req.body.name.trim();
      if (n) updates.name = n;
    }
    if (typeof req.body?.is_private === "boolean") updates.is_private = req.body.is_private;
    if (typeof req.body?.position === "number" && Number.isFinite(req.body.position)) {
      updates.position = Math.trunc(req.body.position);
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    await channelsDao.updateChannel(channelId, updates);

    if (updates.is_private === false) {
      const memberIds = await communityMembersDao.listUserIdsByCommunity(communityId);
      await channelMembersDao.addMembers(channelId, memberIds);
    }

    const updated = await channelsDao.getById(channelId);

    void bumpCommunityEpochs(communityId, { ch: true });

    res.json({ channel: updated });
  } catch (e) {
    logRouteError("PATCH /communities/:communityId/channels/:channelId failed", e, { reqId: req.id, userId, communityId, channelId });
    res.status(500).json({ error: "Failed to update channel" });
  }
});

/** Join a public channel (community member). Private channels use POST .../members (admin). */
app.post("/communities/:communityId/channels/:channelId/join", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    if (ch.is_private) {
      res.status(403).json({ error: "Private channels require an administrator to add you" });
      return;
    }

    await channelMembersDao.addMember(channelId, userId);

    void bumpCommunityEpochs(communityId, { ch: true });

    res.status(201).json({ message: "Joined channel" });
  } catch (e) {
    logRouteError("POST .../channels/:channelId/join failed", e, { reqId: req.id, userId, communityId, channelId });
    res.status(500).json({ error: "Failed to join channel" });
  }
});

/** Leave a channel (removes read access). */
app.post("/communities/:communityId/channels/:channelId/leave", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (ch.is_private && isCommunityAdminRole(membership.role)) {
      res.status(400).json({ error: "Community admins cannot leave private channels they manage" });
      return;
    }

    const removed = await channelMembersDao.removeMember(channelId, userId);
    if (!removed) {
      res.status(404).json({ error: "Not a member of this channel" });
      return;
    }

    void bumpCommunityEpochs(communityId, { ch: true });

    res.json({ message: "Left channel" });
  } catch (e) {
    logRouteError("POST .../channels/:channelId/leave failed", e, { reqId: req.id, userId, communityId, channelId });
    res.status(500).json({ error: "Failed to leave channel" });
  }
});

/** List members with access to a private channel (admin only). */
app.get("/communities/:communityId/channels/:channelId/members", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const adminMembership = await communityMembersDao.getMembership(communityId, userId);

    if (!adminMembership || !isCommunityAdminRole(adminMembership.role)) {
      res.status(403).json({ error: "Only community administrators can view channel members" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!ch.is_private) {
      res.status(400).json({ error: "Public channels are visible to all community members" });
      return;
    }

    const members = await channelMembersDao.listPrivateChannelMembers(communityId, channelId);

    res.json({ members });
  } catch (e) {
    logRouteError("GET .../channels/:channelId/members failed", e, { reqId: req.id, userId, communityId, channelId });
    res.status(500).json({ error: "Failed to list channel members" });
  }
});

/** Add a community member to a private channel (admin only; user-by-user invites). */
app.post("/communities/:communityId/channels/:channelId/members", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);
  const targetUserId = typeof req.body?.user_id === "string" ? req.body.user_id.trim() : "";

  if (!targetUserId) {
    res.status(400).json({ error: "user_id is required" });
    return;
  }

  try {
    const adminMembership = await communityMembersDao.getMembership(communityId, userId);

    if (!adminMembership || !isCommunityAdminRole(adminMembership.role)) {
      res.status(403).json({ error: "Only community administrators can add channel members" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!ch.is_private) {
      res.status(400).json({ error: "Only private channels need member invites" });
      return;
    }

    const targetMembership = await communityMembersDao.getMembership(communityId, targetUserId);

    if (!targetMembership) {
      res.status(400).json({ error: "User is not a member of this community" });
      return;
    }

    const alreadyInChannel = await channelMembersDao.hasMembership(channelId, targetUserId);

    if (alreadyInChannel) {
      res.status(200).json({ message: "User is already in this channel", status: "already_member" });
      return;
    }

    await channelMembersDao.addMemberNoConflict(channelId, targetUserId);
    await publishCommunityEvent({
      type: "community:channel:member:add",
      communityId,
      channelId,
      userId: targetUserId,
      channel: {
        id: ch.id,
        name: ch.name,
        type: ch.type,
        position: ch.position,
        is_private: ch.is_private,
      },
    });

    void bumpCommunityEpochs(communityId, { ch: true });

    res.status(201).json({ message: "Added to channel", status: "added" });
  } catch (e) {
    logRouteError("POST .../channels/:channelId/members failed", e, { reqId: req.id, userId, communityId, channelId, targetUserId });
    res.status(500).json({ error: "Failed to add channel member" });
  }
});

/** Remove a member from a private channel (admin only). */
app.delete("/communities/:communityId/channels/:channelId/members/:targetUserId", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);
  const targetUserId = String(req.params.targetUserId);

  try {
    const adminMembership = await communityMembersDao.getMembership(communityId, userId);

    if (!adminMembership || !isCommunityAdminRole(adminMembership.role)) {
      res.status(403).json({ error: "Only community administrators can remove channel members" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }
    if (!ch.is_private) {
      res.status(400).json({ error: "Public channels are visible to all community members" });
      return;
    }
    if (targetUserId === userId) {
      res.status(400).json({ error: "Admins cannot remove their own access from private channels" });
      return;
    }

    const removed = await channelMembersDao.removeMember(channelId, targetUserId);
    if (!removed) {
      res.status(404).json({ error: "User is not a member of this channel" });
      return;
    }

    await publishCommunityEvent({
      type: "community:channel:member:remove",
      communityId,
      channelId,
      userId: targetUserId,
    });

    void bumpCommunityEpochs(communityId, { ch: true });

    res.status(204).send();
  } catch (e) {
    logRouteError("DELETE .../channels/:channelId/members/:targetUserId failed", e, {
      reqId: req.id,
      userId,
      communityId,
      channelId,
      targetUserId,
    });
    res.status(500).json({ error: "Failed to remove channel member" });
  }
});

/** Delete a channel (owner/admin only). Cannot remove the last channel in a community. */
app.delete("/communities/:communityId/channels/:channelId", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const membership = await communityMembersDao.getMembership(communityId, userId);

    if (!membership || !isCommunityAdminRole(membership.role)) {
      res.status(403).json({ error: "Only community administrators can delete channels" });
      return;
    }

    const ch = await channelsDao.getByIdInCommunity(communityId, channelId);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const channelCount = await channelsDao.countByCommunity(communityId);
    if (channelCount <= 1) {
      res.status(400).json({ error: "Cannot delete the last channel in a community" });
      return;
    }

    await channelsDao.deleteById(channelId);

    await publishCommunityEvent({
      type: "community:channel:delete",
      communityId,
      channelId,
    });

    void bumpCommunityEpochs(communityId, { ch: true });

    res.status(204).send();
  } catch (e) {
    logRouteError("DELETE /communities/:communityId/channels/:channelId failed", e, { reqId: req.id, userId, communityId, channelId });
    res.status(500).json({ error: "Failed to delete channel" });
  }
});

app.post("/internal/log-level", (req: Request, res: Response) => {
  const { level } = req.body as { level?: string };
  const valid = ["trace", "debug", "info", "warn", "error", "fatal"];
  if (!level || !valid.includes(level)) {
    res.status(400).json({ error: `level must be one of: ${valid.join(", ")}` });
    return;
  }
  logger.level = level;
  res.json({ level: logger.level });
});

const port = Number(env.COMMUNITIES_PORT);
const server = app.listen(port, () => {
  logger.info({ port }, "service started");
});
// keepAliveTimeout > nginx upstream keepalive_timeout (60s default) + headersTimeout > keepAliveTimeout
// Prevents ERR_INCOMPLETE_CHUNKED_ENCODING when nginx reuses a socket Node just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
