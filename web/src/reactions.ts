import type { Reaction } from "./types";

const DEFAULT_PICKS = ["🍅", "🥚", "💩", "❤️", "😂", "👏"];
const PICKS_KEY = "balcony.quickPicks";

/** A quick-pick button, in display order. `usedAt` decides which one a new emoji replaces. */
export interface QuickPick {
  emoji: string;
  usedAt: number;
}

// Defaults count as used in reverse order, so new emoji push out 👏 first and 🍅 last.
const defaults = (): QuickPick[] => DEFAULT_PICKS.map((emoji, i) => ({ emoji, usedAt: -i }));

export function readQuickPicks(): QuickPick[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "null");
    if (
      Array.isArray(saved) &&
      saved.length === DEFAULT_PICKS.length &&
      saved.every((p) => isEmoji(p?.emoji) && typeof p.usedAt === "number")
    ) {
      return saved;
    }
  } catch {
    // Unreadable or blocked storage: fall back to the defaults.
  }
  return defaults();
}

export function saveQuickPicks(picks: QuickPick[]): void {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify(picks));
  } catch {
    // Not saved; the picks still apply for this visit.
  }
}

/**
 * Records a throw. A pick already on the bar stays where it is, so the buttons don't move
 * under the cursor. A new emoji goes first and replaces the least recently used pick.
 */
export function recordQuickPick(picks: QuickPick[], emoji: string, now = Date.now()): QuickPick[] {
  if (picks.some((p) => p.emoji === emoji)) {
    return picks.map((p) => (p.emoji === emoji ? { emoji, usedAt: now } : p));
  }
  const stale = picks.reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
  return [{ emoji, usedAt: now }, ...picks.filter((p) => p !== stale)];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;

/** Same rule as the server: exactly one grapheme that is pictographic, a flag or a keycap. */
export function isEmoji(v: string): boolean {
  if (!v || v.length > 32) return false;
  const [first, second] = graphemes.segment(v);
  return !!first && !second && (PICTOGRAPHIC.test(v) || FLAG.test(v) || KEYCAP.test(v));
}

/** Index of the first reaction later than `t`, in a list sorted by videoTime. */
function after(sorted: Reaction[], t: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].videoTime <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Reactions with from < videoTime <= to. */
export function between(sorted: Reaction[], from: number, to: number): Reaction[] {
  return sorted.slice(after(sorted, from), after(sorted, to));
}

export function insertSorted(sorted: Reaction[], r: Reaction): Reaction[] {
  if (sorted.some((x) => x.id === r.id)) return sorted;
  const i = after(sorted, r.videoTime);
  return [...sorted.slice(0, i), r, ...sorted.slice(i)];
}

export interface Hotspot {
  /** Middle of the busiest stretch, for placing the marker. */
  t: number;
  /** Where clicking jumps to: a little before the burst, so it rains on the way in. */
  seekTo: number;
  count: number;
  /** The most-thrown emoji in this stretch. */
  emoji: string;
  /** 0..1, relative to the busiest moment in the video. */
  strength: number;
}

// A moment is a hotspot when it has at least this share of the busiest moment's reactions.
// Measured against the peak, not the total, so a long video with lots of reactions spread
// across it still shows its real highlights.
const HOTSPOT_SHARE = 0.1;
// Slicing is by video time, never by screen size, so every viewer gets the same hotspots.
const SLICES = 100;
// Busy slices with at most this many quiet slices between them count as one hotspot.
const MERGE_GAP_SLICES = 2;
const SEEK_LEAD_S = 2;

/** Splits the video into equal slices and keeps the busy ones, merging near neighbours. */
export function hotspots(sorted: Reaction[], duration: number): Hotspot[] {
  if (duration <= 0 || !sorted.length) return [];
  const counts = new Array<number>(SLICES).fill(0);
  const tallies = Array.from({ length: SLICES }, () => new Map<string, number>());
  for (const r of sorted) {
    const i = Math.min(SLICES - 1, Math.floor((r.videoTime / duration) * SLICES));
    counts[i]++;
    tallies[i].set(r.emoji, (tallies[i].get(r.emoji) ?? 0) + 1);
  }
  const max = Math.max(...counts);
  const threshold = Math.max(1, max * HOTSPOT_SHARE);

  const runs: { from: number; to: number }[] = [];
  counts.forEach((c, i) => {
    if (c < threshold) return;
    const last = runs.at(-1);
    if (last && i - last.to - 1 <= MERGE_GAP_SLICES) last.to = i;
    else runs.push({ from: i, to: i });
  });

  const slice = duration / SLICES;
  return runs.map(({ from, to }) => {
    let peak = from;
    let count = 0;
    const emoji = new Map<string, number>();
    for (let i = from; i <= to; i++) {
      if (counts[i] > counts[peak]) peak = i;
      count += counts[i];
      tallies[i].forEach((n, e) => emoji.set(e, (emoji.get(e) ?? 0) + n));
    }
    // Ties go to the lower code point, so viewers whose lists arrived in a different order still agree.
    const top = [...emoji].reduce((a, b) => (b[1] > a[1] || (b[1] === a[1] && b[0] < a[0]) ? b : a))[0];
    return {
      t: (peak + 0.5) * slice,
      seekTo: Math.max(0, from * slice - SEEK_LEAD_S),
      count,
      emoji: top,
      strength: counts[peak] / max,
    };
  });
}
