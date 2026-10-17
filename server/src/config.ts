import path from "node:path";

export interface Config {
  port: number;
  /** Public origin, e.g. https://balcony.chat. Null derives it from each request. */
  baseUrl: string | null;
  googleClientId: string;
  googleClientSecret: string;
  sessionSecret: string;
  secureCookies: boolean;
  cosmos: { endpoint: string; database: string; container: string; reactionsContainer: string } | null;
  webDist: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(): Config {
  const env = process.env;
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");

  const baseUrl = env.BASE_URL ? env.BASE_URL.replace(/\/+$/, "") : null;

  return {
    port: Number(env.PORT ?? 8080),
    baseUrl,
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    sessionSecret,
    secureCookies: baseUrl ? baseUrl.startsWith("https://") : env.NODE_ENV === "production",
    cosmos: env.COSMOS_ENDPOINT
      ? {
          endpoint: env.COSMOS_ENDPOINT,
          database: env.COSMOS_DATABASE ?? "balcony",
          container: env.COSMOS_CONTAINER ?? "messages",
          reactionsContainer: env.COSMOS_REACTIONS_CONTAINER ?? "reactions",
        }
      : null,
    webDist: env.WEB_DIST ?? path.resolve(import.meta.dirname, "../../web/dist"),
  };
}
