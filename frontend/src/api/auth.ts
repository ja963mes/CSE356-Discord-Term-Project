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
  presence: string;
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

