import { SignJWT, jwtVerify, type JWTPayload } from "jose";

export interface User {
  id: string;
  name: string;
  avatar: string | null;
  channelId: string | null;
}

export const SESSION_COOKIE = "balcony_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const keys = new Map<string, Uint8Array>();
function key(secret: string): Uint8Array {
  let k = keys.get(secret);
  if (!k) keys.set(secret, (k = new TextEncoder().encode(secret)));
  return k;
}

/** Short-lived signed token for arbitrary claims (OAuth state, sessions). */
export async function sign(claims: JWTPayload, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key(secret));
}

export async function verify(token: string | undefined, secret: string): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    return payload;
  } catch {
    return null;
  }
}

export function signSession(user: User, secret: string): Promise<string> {
  return sign(
    { sub: user.id, name: user.name, avatar: user.avatar, ch: user.channelId },
    secret,
    SESSION_TTL_SECONDS,
  );
}

export async function readSession(cookieHeader: string | undefined, secret: string): Promise<User | null> {
  const p = await verify(parseCookies(cookieHeader)[SESSION_COOKIE], secret);
  if (!p || typeof p.sub !== "string" || typeof p.name !== "string") return null;
  return {
    id: p.sub,
    name: p.name,
    avatar: typeof p.avatar === "string" ? p.avatar : null,
    channelId: typeof p.ch === "string" ? p.ch : null,
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        // Malformed value from some other cookie on the domain; ignore it.
      }
    }
  }
  return out;
}
