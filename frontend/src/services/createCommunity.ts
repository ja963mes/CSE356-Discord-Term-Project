import type { Community } from "../api/discord";

export type CreateCommunityResult =
  | { ok: true; community: Community }
  | { ok: false; error: string };

/**
 * Creates a community via POST /create-community (create-community service). At most 100 communities
 * per user; joins are unlimited via a separate flow.
 */
export async function createCommunity(serverName: string): Promise<CreateCommunityResult> {
  const name = serverName.trim();
  if (!name) {
    return { ok: false, error: "Server name is required." };
  }

  let res: Response;
  try {
    res = await fetch("/create-community", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch {
    return { ok: false, error: "Network error. Is the communities service running?" };
  }

  const data = (await res.json().catch(() => ({}))) as { community?: Community; error?: string };

  if (!res.ok) {
    return {
      ok: false,
      error: data.error ?? `Could not create server (${res.status}).`,
    };
  }

  if (!data.community?.id) {
    return { ok: false, error: "Invalid response from server." };
  }

  return { ok: true, community: data.community };
}
