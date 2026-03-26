import express from "express";
import dotenv from "dotenv";
import { desc, sql } from "drizzle-orm";
import { db } from "./db";
import { communities } from "./db/schema";
import { env } from "./env";

// Ensure .env is loaded (some tooling doesn&apos;t load it via env.ts as expected).
dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "search-communities-service" });
});

/**
 * Directory search: returns public communities matching by name.
 * No membership checks (communities are public + searchable by spec).
 *
 * Query:
 * - q: search string (required)
 * - limit: optional max results (default 25, max 100)
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
    // Use case-insensitive match for better UX.
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

    res.json({
      query: q,
      communities: rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to search communities" });
  }
});

const port = Number(env.SEARCH_COMMUNITIES_PORT);
app.listen(port, () => {
  console.log(`search-communities service running on port ${port}`);
});

