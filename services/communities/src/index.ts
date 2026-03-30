/// <reference path="./types/express.d.ts" />
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { eq, and, asc, desc, sql, or, isNotNull, max, inArray } from "drizzle-orm";
import { db } from "./db";
import { env } from "./env";
import { requireAuth } from "./middleware/session";
import { communities, communityMembers, channels, channelMembers, users } from "./db/schema";

function isCommunityAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

async function addUserToAllPublicChannels(communityId: string, userId: string): Promise<void> {
  const publicChans = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.community_id, communityId), eq(channels.is_private, false)));
  for (const c of publicChans) {
    await db.insert(channelMembers).values({ channel_id: c.id, user_id: userId }).onConflictDoNothing();
  }
}

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "communities-service" });
});

/**
 * Public directory search: all communities matching name (no membership filter).
 * Query: q (required for results), limit (optional, default 25, max 100).
 */
app.get("/search-communities", async (req, res) => {
  const qRaw = String(req.query.q ?? "");
  const q = qRaw.trim();
  const limitRaw = req.query.limit;
  const limit = Math.min(Number(limitRaw ?? 25) || 25, 100);

  if (!q) {
    res.json({ query: "", communities: [] as Array<{ id: string; name: string; created_at: string }> });
    return;
  }

  try {
    const pattern = `%${q}%`;
    const rows = await db
      .select({
        id: communities.id,
        name: communities.name,
        created_at: communities.created_at,
      })
      .from(communities)
      .where(sql`${communities.name} ILIKE ${pattern}`)
      .orderBy(desc(communities.created_at))
      .limit(limit);

    res.json({ query: q, communities: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to search communities" });
  }
});

/** List communities the current user belongs to. */
app.get("/communities", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  try {
    const rows = await db
      .select({
        id: communities.id,
        name: communities.name,
        created_at: communities.created_at,
      })
      .from(communities)
      .innerJoin(communityMembers, eq(communities.id, communityMembers.community_id))
      .where(eq(communityMembers.user_id, userId));

    res.json({ communities: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to list communities" });
  }
});

/** Join a community (open join for any authenticated user). */
app.post("/communities/:communityId/join", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const [exists] = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, communityId)).limit(1);
    if (!exists) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    const [already] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (already) {
      res.status(200).json({ message: "Already a member" });
      return;
    }

    await db.insert(communityMembers).values({
      community_id: communityId,
      user_id: userId,
      role: "member",
    });

    await addUserToAllPublicChannels(communityId, userId);

    res.status(201).json({ message: "Joined community" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to join community" });
  }
});

/** Leave a community (removes membership row). */
app.post("/communities/:communityId/leave", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const [exists] = await db.select({ id: communities.id }).from(communities).where(eq(communities.id, communityId)).limit(1);
    if (!exists) {
      res.status(404).json({ error: "Community not found" });
      return;
    }

    const deleted = await db
      .delete(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .returning({ community_id: communityMembers.community_id });

    if (deleted.length === 0) {
      res.status(404).json({ error: "Not a member of this community" });
      return;
    }

    const channelIds = await db.select({ id: channels.id }).from(channels).where(eq(channels.community_id, communityId));
    if (channelIds.length > 0) {
      await db.delete(channelMembers).where(
        and(
          eq(channelMembers.user_id, userId),
          inArray(
            channelMembers.channel_id,
            channelIds.map((r) => r.id)
          )
        )
      );
    }

    res.json({ message: "Left community" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to leave community" });
  }
});

/** Channels in a community (must be a member). */
app.get("/communities/:communityId/channels", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const rows = await db
      .select({
        id: channels.id,
        name: channels.name,
        type: channels.type,
        position: channels.position,
        is_private: channels.is_private,
        channel_member_user_id: channelMembers.user_id,
      })
      .from(channels)
      .leftJoin(
        channelMembers,
        and(eq(channelMembers.channel_id, channels.id), eq(channelMembers.user_id, userId))
      )
      .where(
        and(
          eq(channels.community_id, communityId),
          or(eq(channels.is_private, false), isNotNull(channelMembers.user_id))
        )
      )
      .orderBy(asc(channels.position), asc(channels.name));

    const channelsOut = rows.map(({ channel_member_user_id, ...ch }) => ({
      ...ch,
      joined: channel_member_user_id != null,
    }));

    res.json({ channels: channelsOut });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to list channels" });
  }
});

/** Members with display names and roles. */
app.get("/communities/:communityId/members", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);

  try {
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const rows = await db
      .select({
        user_id: communityMembers.user_id,
        username: users.username,
        profile: users.profile,
        role: communityMembers.role,
        joined_at: communityMembers.joined_at,
      })
      .from(communityMembers)
      .innerJoin(users, eq(users.internal_id, communityMembers.user_id))
      .where(eq(communityMembers.community_id, communityId));

    const members = rows.map((row) => {
      const profile = (row.profile as { displayName?: string } | null) ?? {};
      const displayName = profile.displayName ?? row.username;
      return {
        user_id: row.user_id,
        username: row.username,
        display_name: displayName,
        role: row.role,
        joined_at: row.joined_at,
      };
    });

    res.json({ members });
  } catch (e) {
    console.error(e);
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
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }
    if (!isCommunityAdminRole(membership.role)) {
      res.status(403).json({ error: "Only community administrators can create channels" });
      return;
    }

    const [agg] = await db.select({ mx: max(channels.position) }).from(channels).where(eq(channels.community_id, communityId));
    const nextPosition =
      typeof req.body?.position === "number" && Number.isFinite(req.body.position)
        ? Math.trunc(req.body.position)
        : Number(agg?.mx ?? -1) + 1;

    const [created] = await db
      .insert(channels)
      .values({
        community_id: communityId,
        name,
        type,
        position: nextPosition,
        is_private: isPrivate,
      })
      .returning();

    if (isPrivate) {
      await db.insert(channelMembers).values({ channel_id: created.id, user_id: userId }).onConflictDoNothing();
    } else {
      const members = await db
        .select({ user_id: communityMembers.user_id })
        .from(communityMembers)
        .where(eq(communityMembers.community_id, communityId));
      for (const m of members) {
        await db.insert(channelMembers).values({ channel_id: created.id, user_id: m.user_id }).onConflictDoNothing();
      }
    }

    res.status(201).json({ channel: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create channel" });
  }
});

/** Update channel metadata or visibility (owner/admin only). */
app.patch("/communities/:communityId/channels/:channelId", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!membership || !isCommunityAdminRole(membership.role)) {
      res.status(403).json({ error: "Only community administrators can update channels" });
      return;
    }

    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.community_id, communityId)))
      .limit(1);

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

    await db.update(channels).set(updates).where(eq(channels.id, channelId));

    if (updates.is_private === false) {
      const members = await db
        .select({ user_id: communityMembers.user_id })
        .from(communityMembers)
        .where(eq(communityMembers.community_id, communityId));
      for (const m of members) {
        await db.insert(channelMembers).values({ channel_id: channelId, user_id: m.user_id }).onConflictDoNothing();
      }
    }

    const [updated] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    res.json({ channel: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update channel" });
  }
});

/** Join a public channel (community member). Private channels use POST .../members (admin). */
app.post("/communities/:communityId/channels/:channelId/join", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.community_id, communityId)))
      .limit(1);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    if (ch.is_private) {
      res.status(403).json({ error: "Private channels require an administrator to add you" });
      return;
    }

    await db.insert(channelMembers).values({ channel_id: channelId, user_id: userId }).onConflictDoNothing();
    res.status(201).json({ message: "Joined channel" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to join channel" });
  }
});

/** Leave a channel (removes read access). */
app.post("/communities/:communityId/channels/:channelId/leave", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const communityId = String(req.params.communityId);
  const channelId = String(req.params.channelId);

  try {
    const [membership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!membership) {
      res.status(403).json({ error: "Not a member of this community" });
      return;
    }

    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.community_id, communityId)))
      .limit(1);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const removed = await db
      .delete(channelMembers)
      .where(and(eq(channelMembers.channel_id, channelId), eq(channelMembers.user_id, userId)))
      .returning({ channel_id: channelMembers.channel_id });

    if (removed.length === 0) {
      res.status(404).json({ error: "Not a member of this channel" });
      return;
    }

    res.json({ message: "Left channel" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to leave channel" });
  }
});

/** Add a community member to a channel (admin only; used for private channels). */
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
    const [adminMembership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
      .limit(1);

    if (!adminMembership || !isCommunityAdminRole(adminMembership.role)) {
      res.status(403).json({ error: "Only community administrators can add channel members" });
      return;
    }

    const [ch] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.id, channelId), eq(channels.community_id, communityId)))
      .limit(1);

    if (!ch) {
      res.status(404).json({ error: "Channel not found" });
      return;
    }

    const [targetMembership] = await db
      .select()
      .from(communityMembers)
      .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, targetUserId)))
      .limit(1);

    if (!targetMembership) {
      res.status(400).json({ error: "User is not a member of this community" });
      return;
    }

    await db.insert(channelMembers).values({ channel_id: channelId, user_id: targetUserId }).onConflictDoNothing();
    res.status(201).json({ message: "Added to channel" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to add channel member" });
  }
});

const port = Number(env.COMMUNITIES_PORT);
app.listen(port, () => {
  console.log(`Communities service running on port ${port}`);
});
