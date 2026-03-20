import crypto from "crypto";
import * as oidcClient from "openid-client";
import { env } from "./env";

// ─── Google OAuth2 ───
export const googleConfig = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  callbackUrl: env.GOOGLE_CALLBACK_URL,
  scope: "openid profile email",
};

// ─── GitHub OAuth2 ───
export const githubConfig = {
  authUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userInfoUrl: "https://api.github.com/user",
  clientId: env.GITHUB_CLIENT_ID,
  clientSecret: env.GITHUB_CLIENT_SECRET,
  callbackUrl: env.GITHUB_CALLBACK_URL,
  scope: "read:user user:email",
};

// ─── Helpers ───
export function generateState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function buildOAuth2AuthUrl(
  config: { authUrl: string; clientId: string; callbackUrl: string; scope: string },
  state: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: "code",
    scope: config.scope,
    state,
  });
  return `${config.authUrl}?${params.toString()}`;
}

// ─── OIDC (Course Provider) ───
let oidcConfig: Awaited<ReturnType<typeof oidcClient.discovery>> | null = null;

export async function getOidcConfig() {
  if (!oidcConfig) {
    oidcConfig = await oidcClient.discovery(
      new URL(env.OIDC_ISSUER_URL),
      env.OIDC_CLIENT_ID,
      env.OIDC_CLIENT_SECRET
    );
  }
  return oidcConfig;
}

export async function buildOidcAuthUrl(state: string, nonce: string): Promise<string> {
  const config = await getOidcConfig();
  const url = oidcClient.buildAuthorizationUrl(config, {
    redirect_uri: env.OIDC_CALLBACK_URL,
    scope: "openid profile email",
    state,
    nonce,
  });
  return url.href;
}

export async function handleOidcCallback(
  currentUrl: URL,
  expectedState: string,
  expectedNonce: string
) {
  const config = await getOidcConfig();
  const tokens = await oidcClient.authorizationCodeGrant(config, currentUrl, {
    expectedState,
    expectedNonce,
  });
  return tokens.claims();
}
