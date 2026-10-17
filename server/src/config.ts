import path from "node:path";

export interface Config {
  port: number;
  /** Public origin, e.g. https://balcony.chat. Null derives it from each request. */
  baseUrl: string | null;
  /**
   * Google sign-in, off unless GOOGLE_SIGN_IN=on. It's parked while the youtube.readonly
   * scope goes through Google's verification; until then everyone signs in as a guest.
   */
  google: { clientId: string; clientSecret: string } | null;
  sessionSecret: string;
  secureCookies: boolean;
  cosmos: {
    endpoint: string;
    database: string;
    container: string;
    reactionsContainer: string;
    quotasContainer: string;
  } | null;
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
    google:
      env.GOOGLE_SIGN_IN === "on"
        ? { clientId: required("GOOGLE_CLIENT_ID"), clientSecret: required("GOOGLE_CLIENT_SECRET") }
        : null,
    sessionSecret,
    secureCookies: baseUrl ? baseUrl.startsWith("https://") : env.NODE_ENV === "production",
    cosmos: env.COSMOS_ENDPOINT
      ? {
          endpoint: env.COSMOS_ENDPOINT,
          database: env.COSMOS_DATABASE ?? "balcony",
          container: env.COSMOS_CONTAINER ?? "messages",
          reactionsContainer: env.COSMOS_REACTIONS_CONTAINER ?? "reactions",
          quotasContainer: env.COSMOS_QUOTAS_CONTAINER ?? "reaction-quotas",
        }
      : null,
    webDist: env.WEB_DIST ?? path.resolve(import.meta.dirname, "../../web/dist"),
  };
}
