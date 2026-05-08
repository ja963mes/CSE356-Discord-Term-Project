import { Router, Request, Response } from "express";
import { searchCommunitiesDirectory } from "../communitiesIndex";

const router = Router();

/**
 * Public community name search (Elasticsearch `wildcard` on indexed names; Postgres is not queried here).
 * Same JSON shape as `GET /search-communities` on communities-service (proxy + cache there).
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

/**
 * Backwards-compat alias for the frontend.
 * Historically the UI called `GET /search-communities?q=...` (proxied by frontend nginx).
 * The directory search endpoint lives on this service as `/directory/communities`.
 */
router.get("/search-communities", async (req: Request, res: Response) => {
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
    console.error("[search] GET /search-communities failed", e);
    res.status(500).json({ error: "Failed to search communities" });
  }
});

export default router;
