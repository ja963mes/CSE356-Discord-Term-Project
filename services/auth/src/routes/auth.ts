import { Router, Request, Response } from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import multer from "multer";
import { db } from "../db";
import { users, identities } from "../db/schema";
import { redis } from "../db/redis";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middleware/session";
import { env } from "../config/env";
import {
  googleConfig,
  githubConfig,
  buildOAuth2AuthUrl,
  generateState,
  buildOidcAuthUrl,
  handleOidcCallback,
} from "../config/oauth";


const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = path.resolve(__dirname, "../../uploads/avatars");
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image files are allowed"));
      return;
    }
    cb(null, true);
  },
});

const router = Router();
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const OAUTH_TEMP_TTL = 600; // 10 minutes
const FRONTEND_ROOT = `${env.FRONTEND_URL.replace(/\/$/, "")}/`;

// ─── Helper: create session ───
async function createSession(res: Response, internalId: string) {
  const token = uuidv4();
  await redis.set(`session:${token}`, internalId, "EX", SESSION_TTL);
  res.cookie("session_token", token, {
    httpOnly: true,
    maxAge: SESSION_TTL * 1000,
  });
}

// ─── Helper: handle OAuth callback for login/register flow ───
async function handleOAuthResult(
  res: Response,
  provider: string,
  providerId: string,
  email?: string,
  displayName?: string
) {
  // Check if this identity is already linked to an account
  const [identity] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.provider_uid, providerId)))
    .limit(1);

  if (identity) {
    // Already linked — log them in
    await createSession(res, identity.internal_id);
    return res.redirect(FRONTEND_ROOT);
  }

  // New OAuth identity — store temporarily so the user can create or link
  const tempToken = crypto.randomBytes(32).toString("hex");
  await redis.set(
    `oauth_temp:${tempToken}`,
    JSON.stringify({ provider, providerId, email, displayName }),
    "EX",
    OAUTH_TEMP_TTL
  );

  res.redirect(`/auth/oauth/pending?token=${tempToken}`);
}

// ─── Helper: handle OAuth callback for the account-linking flow ───
async function handleOAuthLink(
  res: Response,
  userId: string,
  provider: string,
  providerId: string
): Promise<void> {
  const [existing] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.provider, provider), eq(identities.provider_uid, providerId)))
    .limit(1);

  if (existing) {
    const param = existing.internal_id === userId ? "already_linked" : "in_use";
    res.redirect(`${FRONTEND_ROOT}?link_error=${param}&provider=${provider}`);
    return;
  }

  await db.insert(identities).values({ internal_id: userId, provider, provider_uid: providerId });
  res.redirect(`${FRONTEND_ROOT}?linked=${provider}`);
}

// ════════════════════════════════════════════
//  Local Auth
// ════════════════════════════════════════════

// POST /auth/register
router.post("/register", async (req: Request, res: Response): Promise<void> => {
  const { username, password, displayName } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  try {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }

    const hash = await bcrypt.hash(password, 12);

    const [newUser] = await db
      .insert(users)
      .values({
        username,
        password_hash: hash,
        profile: { displayName: displayName || username, avatar: null },
      })
      .returning();

    await createSession(res, newUser.internal_id);
    res.status(201).json({ message: "Registered successfully", internal_id: newUser.internal_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/login
router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (!user || !user.password_hash) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    await createSession(res, user.internal_id);
    res.status(200).json({ message: "Logged in successfully", internal_id: user.internal_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/logout
router.post("/logout", async (req: Request, res: Response): Promise<void> => {
  const token = req.cookies?.session_token;

  if (token) {
    await redis.del(`session:${token}`);
  }

  res.clearCookie("session_token");
  res.status(200).json({ message: "Logged out successfully" });
});

// ════════════════════════════════════════════
//  Google OAuth
// ════════════════════════════════════════════

router.get("/google", (_req: Request, res: Response) => {
  const state = generateState();
  redis.set(`oauth_state:${state}`, "google", "EX", 600);
  res.redirect(buildOAuth2AuthUrl(googleConfig, state));
});

router.get("/google/callback", async (req: Request, res: Response): Promise<void> => {
  const { code, state } = req.query;

  if (!code || !state) {
    res.status(400).json({ error: "Missing code or state" });
    return;
  }

  const stored = await redis.get(`oauth_state:${state as string}`);
  if (!stored) {
    res.status(403).json({ error: "Invalid state" });
    return;
  }

  let isLinkFlow = false;
  let linkUserId = "";
  if (stored.startsWith("{")) {
    const parsed = JSON.parse(stored) as { action?: string; provider?: string; userId?: string };
    if (parsed.action === "link" && parsed.provider === "google" && parsed.userId) {
      isLinkFlow = true;
      linkUserId = parsed.userId;
    } else {
      res.status(403).json({ error: "Invalid state" });
      return;
    }
  } else if (stored !== "google") {
    res.status(403).json({ error: "Invalid state" });
    return;
  }
  await redis.del(`oauth_state:${state as string}`);

  try {
    const tokenRes = await fetch(googleConfig.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: googleConfig.clientId,
        client_secret: googleConfig.clientSecret,
        code: code as string,
        grant_type: "authorization_code",
        redirect_uri: googleConfig.callbackUrl,
      }),
    });
    const tokens = await tokenRes.json() as Record<string, unknown>;

    if (!tokens.access_token) {
      res.status(401).json({ error: "Failed to get access token" });
      return;
    }

    const profileRes = await fetch(googleConfig.userInfoUrl, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await profileRes.json() as Record<string, unknown>;

    if (isLinkFlow) {
      await handleOAuthLink(res, linkUserId, "google", profile.sub as string);
    } else {
      await handleOAuthResult(
        res,
        "google",
        profile.sub as string,
        profile.email as string | undefined,
        profile.name as string | undefined
      );
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OAuth error" });
  }
});

// ════════════════════════════════════════════
//  GitHub OAuth
// ════════════════════════════════════════════

router.get("/github", (_req: Request, res: Response) => {
  const state = generateState();
  redis.set(`oauth_state:${state}`, "github", "EX", 600);
  res.redirect(buildOAuth2AuthUrl(githubConfig, state));
});

router.get("/github/callback", async (req: Request, res: Response): Promise<void> => {
  const { code, state } = req.query;

  if (!code || !state) {
    res.status(400).json({ error: "Missing code or state" });
    return;
  }

  const stored = await redis.get(`oauth_state:${state as string}`);
  if (!stored) {
    res.status(403).json({ error: "Invalid state" });
    return;
  }

  let isLinkFlow = false;
  let linkUserId = "";
  if (stored.startsWith("{")) {
    const parsed = JSON.parse(stored) as { action?: string; provider?: string; userId?: string };
    if (parsed.action === "link" && parsed.provider === "github" && parsed.userId) {
      isLinkFlow = true;
      linkUserId = parsed.userId;
    } else {
      res.status(403).json({ error: "Invalid state" });
      return;
    }
  } else if (stored !== "github") {
    res.status(403).json({ error: "Invalid state" });
    return;
  }
  await redis.del(`oauth_state:${state as string}`);

  try {
    const tokenRes = await fetch(githubConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: githubConfig.clientId,
        client_secret: githubConfig.clientSecret,
        code: code as string,
        redirect_uri: githubConfig.callbackUrl,
      }),
    });
    const tokens = await tokenRes.json() as Record<string, unknown>;

    if (!tokens.access_token) {
      res.status(401).json({ error: "Failed to get access token" });
      return;
    }

    const profileRes = await fetch(githubConfig.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: "application/json",
      },
    });
    const profile = await profileRes.json() as Record<string, unknown>;

    if (isLinkFlow) {
      await handleOAuthLink(res, linkUserId, "github", String(profile.id));
    } else {
      await handleOAuthResult(
        res,
        "github",
        String(profile.id),
        profile.email as string | undefined,
        (profile.name || profile.login) as string | undefined
      );
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OAuth error" });
  }
});

// ════════════════════════════════════════════
//  Course OIDC (CSE 356)
// ════════════════════════════════════════════

router.get("/oidc", async (_req: Request, res: Response): Promise<void> => {
  try {
    const state = generateState();
    const nonce = crypto.randomBytes(16).toString("hex");

    await redis.set(
      `oauth_state:${state}`,
      JSON.stringify({ provider: "oidc", nonce }),
      "EX",
      600
    );

    const url = await buildOidcAuthUrl(state, nonce);
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OIDC initialization error" });
  }
});

router.get("/oidc/callback", async (req: Request, res: Response): Promise<void> => {
  const state = req.query.state as string | undefined;

  if (!state) {
    res.status(400).json({ error: "Missing state" });
    return;
  }

  const storedRaw = await redis.get(`oauth_state:${state}`);
  if (!storedRaw) {
    res.status(403).json({ error: "Invalid state" });
    return;
  }

  const parsed = JSON.parse(storedRaw) as { provider: string; nonce: string; action?: string; userId?: string };
  const { provider, nonce, action, userId } = parsed;

  if (provider !== "oidc") {
    res.status(403).json({ error: "Invalid state" });
    return;
  }
  await redis.del(`oauth_state:${state}`);

  const isLinkFlow = action === "link" && !!userId;

  try {
    const currentUrl = new URL(
      `${req.protocol}://${req.get("host")}${req.originalUrl}`
    );

    const claims = await handleOidcCallback(currentUrl, state, nonce);
    if (!claims) {
      res.status(401).json({ error: "No ID token returned" });
      return;
    }

    if (isLinkFlow) {
      await handleOAuthLink(res, userId!, "oidc", claims.sub);
    } else {
      await handleOAuthResult(
        res,
        "oidc",
        claims.sub,
        claims.email as string | undefined,
        (claims.preferred_username || claims.name) as string | undefined
      );
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OIDC callback error" });
  }
});

// ════════════════════════════════════════════
//  OAuth Completion (create account or link)
// ════════════════════════════════════════════

router.post("/oauth/complete", async (req: Request, res: Response): Promise<void> => {
  const { temp_token, action, username, password } = req.body;

  if (!temp_token || !action || !username) {
    res.status(400).json({ error: "temp_token, action, and username are required" });
    return;
  }

  const tempRaw = await redis.get(`oauth_temp:${temp_token}`);
  if (!tempRaw) {
    res.status(400).json({ error: "Invalid or expired OAuth token" });
    return;
  }

  const { provider, providerId, email, displayName } = JSON.parse(tempRaw);

  try {
    if (action === "create") {
      // ── Create a new account with this OAuth identity ──
      const existing = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (existing.length > 0) {
        res.status(409).json({ error: "Username already taken" });
        return;
      }

      const hash = password ? await bcrypt.hash(password, 12) : null;

      const [newUser] = await db
        .insert(users)
        .values({
          username,
          email: email || null,
          password_hash: hash,
          profile: { displayName: displayName || username, avatar: null },
        })
        .returning();

      await db.insert(identities).values({
        internal_id: newUser.internal_id,
        provider,
        provider_uid: providerId,
      });

      await redis.del(`oauth_temp:${temp_token}`);
      await createSession(res, newUser.internal_id);
      res.status(201).json({ message: "Account created", internal_id: newUser.internal_id });

    } else if (action === "link") {
      // ── Link OAuth identity to an existing account ──
      if (!password) {
        res.status(400).json({ error: "Password required to link to existing account" });
        return;
      }

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      if (!user || !user.password_hash) {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        res.status(401).json({ error: "Invalid username or password" });
        return;
      }

      await db.insert(identities).values({
        internal_id: user.internal_id,
        provider,
        provider_uid: providerId,
      });

      await redis.del(`oauth_temp:${temp_token}`);
      await createSession(res, user.internal_id);
      res.status(200).json({ message: "OAuth linked to account", internal_id: user.internal_id });

    } else {
      res.status(400).json({ error: "action must be 'create' or 'link'" });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ════════════════════════════════════════════
//  OAuth Provider Linking (from settings)
// ════════════════════════════════════════════

router.get("/link/google", requireAuth, (req: Request, res: Response) => {
  const { internal_id } = req.user as { internal_id: string };
  const state = generateState();
  redis.set(`oauth_state:${state}`, JSON.stringify({ action: "link", provider: "google", userId: internal_id }), "EX", 600);
  res.redirect(buildOAuth2AuthUrl(googleConfig, state));
});

router.get("/link/github", requireAuth, (req: Request, res: Response) => {
  const { internal_id } = req.user as { internal_id: string };
  const state = generateState();
  redis.set(`oauth_state:${state}`, JSON.stringify({ action: "link", provider: "github", userId: internal_id }), "EX", 600);
  res.redirect(buildOAuth2AuthUrl(githubConfig, state));
});

router.get("/link/oidc", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  try {
    const state = generateState();
    const nonce = crypto.randomBytes(16).toString("hex");
    await redis.set(
      `oauth_state:${state}`,
      JSON.stringify({ action: "link", provider: "oidc", userId: internal_id, nonce }),
      "EX",
      600
    );
    const url = await buildOidcAuthUrl(state, nonce);
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "OIDC initialization error" });
  }
});

// ════════════════════════════════════════════
//  Profile & Presence
// ════════════════════════════════════════════

// GET /auth/dm-users
router.get("/dm-users", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  try {
    const allUsers = await db
      .select({
        internal_id: users.internal_id,
        username: users.username,
        profile: users.profile,
      })
      .from(users);

    res.json({ users: allUsers.filter((u) => u.internal_id !== internal_id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/me
router.get("/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.internal_id, internal_id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({
      internal_id: user.internal_id,
      username: user.username,
      email: user.email,
      profile: user.profile,
      has_password: !!user.password_hash,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /auth/profile
router.patch("/profile", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  const { displayName } = req.body;

  if (!displayName || typeof displayName !== "string" || !displayName.trim()) {
    res.status(400).json({ error: "displayName is required" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.internal_id, internal_id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const updatedProfile = { ...(user.profile as object), displayName: displayName.trim() };

    await db
      .update(users)
      .set({ profile: updatedProfile })
      .where(eq(users.internal_id, internal_id));

    res.json({ message: "Profile updated", profile: updatedProfile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/profile/avatar
router.post("/profile/avatar", requireAuth, uploadAvatar.single("avatar"), async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };

  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.internal_id, internal_id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Delete old avatar file if one exists
    const oldProfile = user.profile as { avatar?: string | null };
    if (oldProfile.avatar) {
      const oldFilename = oldProfile.avatar.split("/").pop();
      if (oldFilename) {
        const oldPath = path.resolve(__dirname, "../../uploads/avatars", oldFilename);
        fs.unlink(oldPath, () => {}); // best-effort, ignore errors
      }
    }

    const avatarUrl = `/auth/avatars/${req.file.filename}`;
    const updatedProfile = { ...(user.profile as object), avatar: avatarUrl };

    await db
      .update(users)
      .set({ profile: updatedProfile })
      .where(eq(users.internal_id, internal_id));

    res.json({ message: "Avatar uploaded", avatarUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /auth/password — set or change password
router.patch("/password", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  const { currentPassword, newPassword } = req.body;

  if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.internal_id, internal_id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    if (user.password_hash) {
      if (!currentPassword) {
        res.status(400).json({ error: "Current password is required to change your password" });
        return;
      }
      const valid = await bcrypt.compare(currentPassword, user.password_hash);
      if (!valid) {
        res.status(401).json({ error: "Current password is incorrect" });
        return;
      }
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await db.update(users).set({ password_hash: hash }).where(eq(users.internal_id, internal_id));

    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /auth/identities — list linked OAuth providers
router.get("/identities", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  try {
    const rows = await db
      .select({ provider: identities.provider, created_at: identities.created_at })
      .from(identities)
      .where(eq(identities.internal_id, internal_id));

    res.json({ identities: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /auth/identities/:provider — unlink an OAuth provider
router.delete("/identities/:provider", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { internal_id } = req.user as { internal_id: string };
  const provider = req.params.provider as string;

  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.internal_id, internal_id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const allIdentities = await db
      .select()
      .from(identities)
      .where(eq(identities.internal_id, internal_id));

    const remainingAfterRemoval = allIdentities.filter((i) => i.provider !== provider);

    if (remainingAfterRemoval.length === 0 && !user.password_hash) {
      res.status(400).json({ error: "Cannot unlink your only sign-in method. Set a password first." });
      return;
    }

    await db
      .delete(identities)
      .where(and(eq(identities.internal_id, internal_id), eq(identities.provider, provider)));

    res.json({ message: "Provider unlinked" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
