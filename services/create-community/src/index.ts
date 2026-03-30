/// <reference path="./types/express.d.ts" />
import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import { eq, count } from "drizzle-orm";
import { db } from "./db";
import { env } from "./env";
import { requireAuth } from "./middleware/session";
import { communities, communityMembers, channels, channelMembers } from "./db/schema";

const MAX_COMMUNITIES_PER_USER = 100;

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "create-community-service" });
});

/**
 * Dedicated service for creating communities (max 100 per user).
 * Listing, join, channels, and members remain on the communities service.
 */
app.post("/create-community", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.internal_id;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  try {
    const [createdCount] = await db
      .select({ c: count() })
      .from(communities)
      .where(eq(communities.created_by, userId));

    const n = Number(createdCount?.c ?? 0);
    if (n >= MAX_COMMUNITIES_PER_USER) {
      res.status(403).json({ error: `You can create at most ${MAX_COMMUNITIES_PER_USER} communities` });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(communities)
        .values({ name, created_by: userId })
        .returning();

      await tx.insert(communityMembers).values({
        community_id: c.id,
        user_id: userId,
        role: "owner",
      });

      const [general] = await tx
        .insert(channels)
        .values({
          community_id: c.id,
          name: "general",
          type: "text",
          position: 0,
          is_private: false,
        })
        .returning({ id: channels.id });

      await tx.insert(channelMembers).values({
        channel_id: general.id,
        user_id: userId,
      });

      return c;
    });

    res.status(201).json({ community: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create community" });
  }
});

const port = Number(env.CREATE_COMMUNITY_PORT);
app.listen(port, () => {
  console.log(`Create-community service running on port ${port}`);
});
