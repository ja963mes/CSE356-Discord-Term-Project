import { Router, Request, Response } from "express";
import { searchCommunitiesDirectory } from "../communitiesIndex";

const router = Router();

/**
 * Public community name search (same semantics as former GET /search-communities on communities-service).
 * Query: q, limit (default 25, max 100).
 */
router.get("/directory/communities", async (req: Request, res: Response) => {
  const qRaw = String(req.query.q ?? "");
  const q = qRaw.trim().replace(/\s+/g, " ");
  const limitRaw = Number(req.query.limit ?? 25);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 100);

  if (!q) {
    res.json({ query: "", communities: [] as Array<{ id: string; name: string; created_at: string }> });
    return;
  }

  try {
    const communities = await searchCommunitiesDirectory(q, limit);
    res.json({ query: q, communities });
  } catch (e) {
    console.error("[search] GET /directory/communities failed", e);
    res.status(500).json({ error: "Failed to search communities" });
  }
});

export default router;
