/// <reference path="./types/express.d.ts" />
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { eq, and, asc } from "drizzle-orm";
import { db } from "./db";
import { redis } from "./redis";
import { env } from "./env";
import { requireAuth } from "./middleware/session";
import { communities, communityMembers, channels, users } from "./db/schema";

const PRESENCE_TTL_SEC = 120;

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "communities-service" });
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

    res.status(201).json({ message: "Joined community" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to join community" });
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
      })
      .from(channels)
      .where(eq(channels.community_id, communityId))
      .orderBy(asc(channels.position), asc(channels.name));

    res.json({ channels: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to list channels" });
  }
});

/** Members with display names and presence (Redis). */
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

    const members = [];
    for (const row of rows) {
      const profile = (row.profile as { displayName?: string } | null) ?? {};
      const displayName = profile.displayName ?? row.username;
      const raw = await redis.get(`presence:${row.user_id}`);
      let presence: { status: string; updated_at?: string } = { status: "offline" };
      if (raw) {
        try {
          presence = JSON.parse(raw) as { status: string; updated_at?: string };
        } catch {
          presence = { status: "offline" };
        }
      }
      members.push({
        user_id: row.user_id,
        username: row.username,
        display_name: displayName,
        role: row.role,
        joined_at: row.joined_at,
        presence,
      });
    }

    res.json({ members });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to list members" });
  }
});

/** Heartbeat so other members see your presence (stored in Redis). */
app.post("/presence/heartbeat", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const status = typeof req.body?.status === "string" ? req.body.status : "online";
  const allowed = ["online", "idle", "dnd", "offline"];
  if (!allowed.includes(status)) {
    res.status(400).json({ error: "status must be one of: online, idle, dnd, offline" });
    return;
  }

  const payload = JSON.stringify({
    status,
    updated_at: new Date().toISOString(),
  });

  try {
    if (status === "offline") {
      await redis.del(`presence:${userId}`);
    } else {
      await redis.set(`presence:${userId}`, payload, "EX", PRESENCE_TTL_SEC);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update presence" });
  }
});

const port = Number(env.COMMUNITIES_PORT);
app.listen(port, () => {
  console.log(`Communities service running on port ${port}`);
});
