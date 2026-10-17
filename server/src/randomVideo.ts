import { Router } from "express";
import type { Config } from "./config.js";
import { readSession } from "./session.js";
import type { ReactionStore } from "./store.js";

// Listing every reacted video is a cross-partition query, so the list is shared for a few
// minutes. Each request still makes its own fresh pick from it.
const LIST_CACHE_MS = 5 * 60 * 1000;

/**
 * A random video from every video anyone has reacted to. Every video is equally likely:
 * one stray reaction counts the same as ten thousand.
 */
export function randomVideoRouter(config: Config, reactions: ReactionStore): Router {
  const router = Router();
  let cached: { at: number; ids: Promise<string[]> } | null = null;

  router.get("/api/random-video", async (req, res) => {
    if (!(await readSession(req.headers.cookie, config.sessionSecret))) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!cached || Date.now() - cached.at > LIST_CACHE_MS) {
      const ids = reactions.reactedVideoIds();
      cached = { at: Date.now(), ids };
      // Don't keep serving a failure for the whole cache window.
      ids.catch(() => cached?.ids === ids && (cached = null));
    }
    try {
      // `exclude` is the video the viewer is already watching, so "random" never means "this one again".
      const exclude = req.query.exclude;
      const ids = (await cached.ids).filter((id) => id !== exclude);
      if (!ids.length) {
        res.status(404).json({ error: exclude ? "No other videos have reactions yet." : "Nobody has reacted to a video yet." });
        return;
      }
      res.json({ videoId: ids[Math.floor(Math.random() * ids.length)] });
    } catch (err) {
      console.error("Picking a random video failed", err);
      res.status(500).json({ error: "Couldn't pick a video. Try again." });
    }
  });

  return router;
}
