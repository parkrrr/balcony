import { Router } from "express";
import type { Config } from "./config.js";
import { readSession } from "./session.js";
import type { EmojiCount, ReactionStore } from "./store.js";

export const MOST_REACTED_LIMIT = 5;
export const MOST_REACTED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_EMOJI = 3;
// Each refresh is a cross-partition query, so every visitor shares one result for a few minutes.
const RESULT_CACHE_MS = 5 * 60 * 1000;
// Titles only live in memory, well inside the 30-day limit on keeping YouTube data.
const TITLE_CACHE_MS = 6 * 60 * 60 * 1000;
const TITLE_TIMEOUT_MS = 3_000;

export interface VideoInfo {
  title: string;
  channel: string;
}

export interface MostReacted {
  videoId: string;
  /** Null when YouTube didn't say (private, deleted, or the lookup failed). */
  title: string | null;
  channel: string | null;
  total: number;
  /** The most-thrown emoji, most first. */
  top: { emoji: string; count: number }[];
}

export type TitleLookup = (videoId: string) => Promise<VideoInfo | null>;

/** Ranks videos by total reactions, with ties broken by video ID so the order is stable. */
export function rankMostReacted(counts: EmojiCount[], limit = MOST_REACTED_LIMIT): Omit<MostReacted, "title" | "channel">[] {
  const byVideo = new Map<string, EmojiCount[]>();
  for (const c of counts) byVideo.set(c.videoId, [...(byVideo.get(c.videoId) ?? []), c]);
  return [...byVideo]
    .map(([videoId, emoji]) => ({
      videoId,
      total: emoji.reduce((sum, e) => sum + e.count, 0),
      top: emoji
        .sort((a, b) => b.count - a.count || (a.emoji < b.emoji ? -1 : 1))
        .slice(0, TOP_EMOJI)
        .map(({ emoji, count }) => ({ emoji, count })),
    }))
    .sort((a, b) => b.total - a.total || (a.videoId < b.videoId ? -1 : 1))
    .slice(0, limit);
}

/** YouTube's public oEmbed endpoint: title and channel name, no API key or OAuth. */
export const oEmbedLookup: TitleLookup = async (videoId) => {
  const watch = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { title?: unknown; author_name?: unknown };
    return typeof body.title === "string"
      ? { title: body.title, channel: typeof body.author_name === "string" ? body.author_name : "" }
      : null;
  } catch {
    return null;
  }
};

export function mostReactedRouter(config: Config, reactions: ReactionStore, lookup: TitleLookup = oEmbedLookup): Router {
  const router = Router();
  const titles = new Map<string, { info: VideoInfo; at: number }>();
  let cached: { at: number; result: Promise<MostReacted[]> } | null = null;

  const title = async (videoId: string): Promise<VideoInfo | null> => {
    const hit = titles.get(videoId);
    if (hit && Date.now() - hit.at < TITLE_CACHE_MS) return hit.info;
    const info = await lookup(videoId);
    // Only successes are kept, so a failed lookup is retried on the next refresh.
    if (info) titles.set(videoId, { info, at: Date.now() });
    return info;
  };

  const load = async (): Promise<MostReacted[]> => {
    const ranked = rankMostReacted(await reactions.countsSince(Date.now() - MOST_REACTED_WINDOW_MS));
    return Promise.all(
      ranked.map(async (v) => {
        const info = await title(v.videoId);
        return { ...v, title: info?.title ?? null, channel: info?.channel || null };
      }),
    );
  };

  router.get("/api/most-reacted", async (req, res) => {
    if (!(await readSession(req.headers.cookie, config.sessionSecret))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!cached || Date.now() - cached.at > RESULT_CACHE_MS) {
      const result = load();
      cached = { at: Date.now(), result };
      // Don't keep serving a failure for the whole cache window.
      result.catch(() => cached?.result === result && (cached = null));
    }
    try {
      res.json(await cached.result);
    } catch (err) {
      console.error("Loading most reacted failed", err);
      res.status(500).json({ error: "Couldn't load the most reacted videos." });
    }
  });

  return router;
}
