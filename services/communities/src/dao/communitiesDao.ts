import { eq, count, sql } from "drizzle-orm";
import { db } from "../db";
import { communities, communityMembers, channels, channelMembers } from "../db/schema";
import { UserCommunityRow } from "./types";

export async function listForUser(userId: string): Promise<UserCommunityRow[]> {
  return db
    .select({
      id: communities.id,
      name: communities.name,
      created_at: communities.created_at,
      role: communityMembers.role,
    })
    .from(communities)
    .innerJoin(communityMembers, eq(communities.id, communityMembers.community_id))
    .where(eq(communityMembers.user_id, userId));
}

export async function existsById(communityId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: communities.id })
    .from(communities)
    .where(eq(communities.id, communityId))
    .limit(1);
  return Boolean(row);
}

export type CreateCommunityResult =
  | { ok: true; id: string; name: string; created_at: Date }
  | { ok: false; reason: "cap_exceeded" };

/**
 * Create community + owner membership + #general + channel_members in a single tx.
 * Cap check runs inside the tx behind a per-user pg_advisory_xact_lock so concurrent
 * requests serialize and the cap can't be bypassed by races between count-then-insert.
 */
export async function createWithOwnerAndGeneralChannel(
  userId: string,
  name: string,
  maxPerUser: number,
): Promise<CreateCommunityResult> {
  return db.transaction(async (tx) => {
    // Lock auto-releases on COMMIT/ROLLBACK; safe under pgbouncer transaction pooling.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`);

    const [countRow] = await tx
      .select({ c: count() })
      .from(communities)
      .where(eq(communities.created_by, userId));
    if (Number(countRow?.c ?? 0) >= maxPerUser) {
      return { ok: false, reason: "cap_exceeded" } as const;
    }

    const [c] = await tx.insert(communities).values({ name, created_by: userId }).returning();
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
    await tx.insert(channelMembers).values({ channel_id: general.id, user_id: userId });
    return {
      ok: true,
      id: c.id,
      name: c.name,
      created_at: c.created_at instanceof Date ? c.created_at : new Date(String(c.created_at)),
    } as const;
  });
}
