import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { Router, type CookieOptions, type Request } from "express";
import { decodeJwt } from "jose";
import { sameOrigin } from "./chat.js";
import type { Config } from "./config.js";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, parseCookies, readSession, sign, signSession, verify, type User } from "./session.js";

const OAUTH_COOKIE = "balcony_oauth";
const OAUTH_TTL_SECONDS = 10 * 60;
const SCOPES = ["openid", "profile", "https://www.googleapis.com/auth/youtube.readonly"];

/** Only same-site relative paths, so the login flow can't be turned into an open redirect. */
export function safeReturnTo(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/";
}

export function origin(config: Config, req: Request): string {
  return config.baseUrl ?? `${req.protocol}://${req.get("host")}`;
}

export const MAX_NAME_LENGTH = 32;
// Bidi controls let a name display in a different order than it's stored, e.g. to fake another name.
const UNSAFE_CHARS = /[\p{Cc}‪-‮⁦-⁩]/gu;

/** A display name as typed, tidied up; null if nothing usable is left or it's too long. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  // Whitespace first: tabs and newlines are control characters too, but should become spaces.
  const name = value.normalize("NFC").replace(/\s+/g, " ").replace(UNSAFE_CHARS, "").trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

export function authRouter(config: Config): Router {
  const router = Router();
  const cookieBase: CookieOptions = { httpOnly: true, sameSite: "lax", secure: config.secureCookies };
  const setSession = async (res: express.Response, user: User) =>
    res.cookie(SESSION_COOKIE, await signSession(user, config.sessionSecret), {
      ...cookieBase,
      path: "/",
      maxAge: SESSION_TTL_SECONDS * 1000,
    });

  // Honor system: anyone can be anyone. Each sign-in is a new identity, and names needn't be unique.
  router.post("/auth/guest", express.json({ limit: "1kb" }), async (req, res) => {
    if (!sameOrigin(config, req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const name = cleanName((req.body as { name?: unknown } | undefined)?.name);
    if (!name) {
      res.status(400).json({ error: `Pick a name of 1–${MAX_NAME_LENGTH} characters.` });
      return;
    }
    // Prefixed so guest IDs can never collide with Google account IDs once that sign-in returns.
    const user: User = { id: `guest:${randomUUID()}`, name, avatar: null, channelId: null };
    await setSession(res, user);
    res.json(user);
  });

  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...cookieBase, path: "/" });
    res.status(204).end();
  });

  router.get("/api/me", async (req, res) => {
    const user = await readSession(req.headers.cookie, config.sessionSecret);
    if (!user) {
      // Tells the sign-in screen whether to offer the Google button.
      res.status(401).json({ error: "unauthorized", google: config.google !== null });
      return;
    }
    res.json(user);
  });

  const google = config.google;
  if (!google) return router;

  router.get("/auth/login", async (req, res) => {
    const state = randomBytes(16).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const returnTo = safeReturnTo(req.query.returnTo);

    res.cookie(OAUTH_COOKIE, await sign({ state, verifier, returnTo }, config.sessionSecret, OAUTH_TTL_SECONDS), {
      ...cookieBase,
      path: "/auth",
      maxAge: OAUTH_TTL_SECONDS * 1000,
    });

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: `${origin(config, req)}/auth/callback`,
      response_type: "code",
      scope: SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // Lets people with several channels (brand accounts) pick which one to chat as.
      prompt: "select_account",
    }).toString();
    res.redirect(url.toString());
  });

  router.get("/auth/callback", async (req, res) => {
    const pending = await verify(parseCookies(req.headers.cookie)[OAUTH_COOKIE], config.sessionSecret);
    res.clearCookie(OAUTH_COOKIE, { ...cookieBase, path: "/auth" });
    const returnTo = safeReturnTo(pending?.returnTo);

    if (!pending || req.query.state !== pending.state || typeof req.query.code !== "string") {
      res.redirect(returnTo);
      return;
    }

    try {
      const user = await exchangeCode(google, req.query.code, String(pending.verifier), `${origin(config, req)}/auth/callback`);
      await setSession(res, user);
    } catch (err) {
      console.error("OAuth callback failed", err);
    }
    res.redirect(returnTo);
  });

  return router;
}

async function exchangeCode(
  google: NonNullable<Config["google"]>,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<User> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: google.clientId,
      client_secret: google.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokens = (await tokenRes.json()) as { access_token: string; id_token: string };

  // The ID token came straight from Google's token endpoint over TLS, so its
  // claims can be trusted without re-verifying the signature (OIDC Core 3.1.3.7).
  const claims = decodeJwt(tokens.id_token);
  if (typeof claims.sub !== "string") throw new Error("ID token has no subject");

  const user: User = {
    id: claims.sub,
    name: typeof claims.name === "string" ? claims.name : "YouTube viewer",
    avatar: typeof claims.picture === "string" ? claims.picture : null,
    channelId: null,
  };

  // Prefer the YouTube channel identity; fall back to the Google profile if the
  // account has no channel or the Data API call fails.
  const channelRes = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (channelRes.ok) {
    const body = (await channelRes.json()) as {
      items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[];
    };
    const channel = body.items?.[0];
    if (channel) {
      user.channelId = channel.id;
      user.name = channel.snippet.title;
      user.avatar = channel.snippet.thumbnails?.default?.url ?? user.avatar;
    }
  } else {
    console.warn("YouTube channel lookup failed", channelRes.status);
  }
  return user;
}
