import { Router, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { communityMembers, channelMembers, channels, dmParticipants } from "../db/schema";
import { requireAuth } from "../middleware/session";
import { searchMessages } from "../elasticsearch";

const router = Router();

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

router.get("/search/messages", requireAuth, async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "q (search query) is required" });
    return;
  }

  const scope = String(req.query.scope ?? "");
  if (scope !== "community" && scope !== "dm") {
    res.status(400).json({ error: 'scope must be "community" or "dm"' });
    return;
  }

  const userId = req.user!.internal_id;
  const limitRaw = Number(req.query.limit ?? 25);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 50);
  const offsetRaw = Number(req.query.offset ?? 0);
  const offset = Math.max(Number.isFinite(offsetRaw) ? offsetRaw : 0, 0);

  const authorId = req.query.authorId ? String(req.query.authorId) : undefined;
  if (authorId && !isUuid(authorId)) {
    res.status(400).json({ error: "authorId must be a valid UUID" });
    return;
  }

  const before = req.query.before ? String(req.query.before) : undefined;
  const after = req.query.after ? String(req.query.after) : undefined;

  let scopeIds: string[];

  if (scope === "community") {
    const communityIdRaw = req.query.communityId ? String(req.query.communityId) : "";
    const communityId = communityIdRaw && isUuid(communityIdRaw) ? communityIdRaw : null;

    if (communityIdRaw && !communityId) {
      res.status(400).json({ error: "communityId must be a valid UUID" });
      return;
    }

    if (communityId) {
      // Single query: get channels the user is a member of within this community.
      // If the result is empty the user is either not in the community or has no channels — both are safe to treat as 403.
      const userChannels = await db
        .select({ channel_id: channelMembers.channel_id })
        .from(channelMembers)
        .innerJoin(channels, eq(channels.id, channelMembers.channel_id))
        .innerJoin(communityMembers, and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
        .where(and(eq(channels.community_id, communityId), eq(channelMembers.user_id, userId)));

      if (userChannels.length === 0) {
        // Distinguish "not a member" from "member but no channels" by checking membership alone
        const [membership] = await db
          .select({ user_id: communityMembers.user_id })
          .from(communityMembers)
          .where(and(eq(communityMembers.community_id, communityId), eq(communityMembers.user_id, userId)))
          .limit(1);
        if (!membership) {
          res.status(403).json({ error: "You are not a member of this community" });
          return;
        }
        // Member but no accessible channels
        res.json({ query: q, total: 0, results: [] });
        return;
      }

      scopeIds = userChannels.map((r) => r.channel_id);
    } else {
      // No communityId — search across all communities the user has access to
      const userChannels = await db
        .select({ channel_id: channelMembers.channel_id })
        .from(channelMembers)
        .where(eq(channelMembers.user_id, userId));

      scopeIds = userChannels.map((r) => r.channel_id);
    }

    if (scopeIds.length === 0) {
      res.json({ query: q, total: 0, results: [] });
      return;
    }

    const results = await searchMessages({
      query: q,
      scopeIds,
      scopeType: "channel",
      communityId: communityId ?? undefined,
      authorId,
      before,
      after,
      limit,
      offset,
    });

    res.json({ query: q, ...results });
  } else {
    // scope === "dm"
    const conversationId = String(req.query.conversationId ?? "");
    if (!conversationId || !isUuid(conversationId)) {
      res.status(400).json({ error: "conversationId (UUID) is required for dm scope" });
      return;
    }

    // Verify user is a participant
    const [participant] = await db
      .select({ user_id: dmParticipants.user_id })
      .from(dmParticipants)
      .where(and(eq(dmParticipants.conversation_id, conversationId), eq(dmParticipants.user_id, userId)))
      .limit(1);

    if (!participant) {
      res.status(403).json({ error: "You are not a participant in this conversation" });
      return;
    }

    scopeIds = [conversationId];

    const results = await searchMessages({
      query: q,
      scopeIds,
      scopeType: "dm",
      authorId,
      before,
      after,
      limit,
      offset,
    });

    res.json({ query: q, ...results });
  }
});

export default router;
