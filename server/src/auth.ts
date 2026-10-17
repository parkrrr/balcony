import { createHash, randomBytes } from "node:crypto";
import { Router, type CookieOptions, type Request } from "express";
import { decodeJwt } from "jose";
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

export function authRouter(config: Config): Router {
  const router = Router();
  const cookieBase: CookieOptions = { httpOnly: true, sameSite: "lax", secure: config.secureCookies };

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
      client_id: config.googleClientId,
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
      const user = await exchangeCode(config, req.query.code, String(pending.verifier), `${origin(config, req)}/auth/callback`);
      res.cookie(SESSION_COOKIE, await signSession(user, config.sessionSecret), {
        ...cookieBase,
        path: "/",
        maxAge: SESSION_TTL_SECONDS * 1000,
      });
    } catch (err) {
      console.error("OAuth callback failed", err);
    }
    res.redirect(returnTo);
  });

  router.post("/auth/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...cookieBase, path: "/" });
    res.status(204).end();
  });

  router.get("/api/me", async (req, res) => {
    const user = await readSession(req.headers.cookie, config.sessionSecret);
    if (!user) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json(user);
  });

  return router;
}

async function exchangeCode(config: Config, code: string, verifier: string, redirectUri: string): Promise<User> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
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
