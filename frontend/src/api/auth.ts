export type LoginResponse = { message: string; internal_id: string };

export async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Login failed");
  }

  return (await res.json()) as LoginResponse;
}

export async function register(username: string, password: string, displayName?: string): Promise<void> {
  const res = await fetch("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password, displayName }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Registration failed");
  }
}

export async function logout(): Promise<void> {
  const res = await fetch("/auth/logout", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error("Logout failed");
}

export interface Me {
  internal_id: string;
  username: string;
  email: string | null;
  profile: { displayName: string; avatar: string | null };
  has_password: boolean;
}

export interface LinkedIdentity {
  provider: string;
  created_at: string;
}

export async function getIdentities(): Promise<LinkedIdentity[]> {
  const res = await fetch("/auth/identities", { credentials: "include" });
  if (!res.ok) return [];
  const data = (await res.json()) as { identities: LinkedIdentity[] };
  return data.identities;
}

export async function changePassword(currentPassword: string | undefined, newPassword: string): Promise<void> {
  const res = await fetch("/auth/password", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to update password");
  }
}

export async function unlinkProvider(provider: string): Promise<void> {
  const res = await fetch(`/auth/identities/${provider}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to unlink provider");
  }
}

export async function getMe(): Promise<Me> {
  const res = await fetch("/auth/me", { credentials: "include" });
  if (!res.ok) throw new Error("Not authenticated");
  return (await res.json()) as Me;
}

export async function updateProfile(displayName: string): Promise<void> {
  const res = await fetch("/auth/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) throw new Error("Failed to update profile");
}

export interface DmUser {
  internal_id: string;
  username: string;
  /** May be `{}` or omit displayName until the user sets a profile (see DB default). */
  profile?: { displayName?: string; avatar?: string | null };
}

/** Safe label for lists/search; avoids crashing when `profile` or `displayName` is missing. */
export function displayNameForDmUser(u: DmUser | null | undefined): string {
  if (!u) return "User";
  const name = u.profile?.displayName?.trim();
  if (name) return name;
  return u.username || "User";
}

function coerceDmProfile(raw: unknown): DmUser["profile"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  return {
    displayName: typeof o.displayName === "string" ? o.displayName : undefined,
    avatar: o.avatar === null ? null : typeof o.avatar === "string" ? o.avatar : undefined,
  };
}

/** Normalize API/proxy quirks so we never hand React a non-array or rows missing ids (avoids full-app crash). */
export function normalizeDmUsersPayload(raw: unknown): DmUser[] {
  if (raw == null || typeof raw !== "object" || !("users" in raw)) return [];
  const { users } = raw as { users: unknown };
  if (!Array.isArray(users)) return [];
  const out: DmUser[] = [];
  for (const item of users) {
    if (item == null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const internal_id =
      typeof row.internal_id === "string"
        ? row.internal_id
        : row.internal_id != null
          ? String(row.internal_id)
          : "";
    if (!internal_id) continue;
    out.push({
      internal_id,
      username: typeof row.username === "string" ? row.username : "",
      profile: coerceDmProfile(row.profile),
    });
  }
  return out;
}

// TODO: replace with real DM participants once Direct Conversations service is built
export async function getDmUsers(): Promise<DmUser[]> {
  const res = await fetch("/auth/dm-users", { credentials: "include" });
  if (!res.ok) return [];
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  return normalizeDmUsersPayload(body);
}

export async function uploadAvatar(file: File): Promise<string> {
  const form = new FormData();
  form.append("avatar", file);
  const res = await fetch("/auth/profile/avatar", {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload avatar");
  const data = (await res.json()) as { avatarUrl: string };
  return data.avatarUrl;
}

