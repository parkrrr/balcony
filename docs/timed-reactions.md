# Timed reactions

**Status:** built.

Viewers throw emoji, for example a 🍅 at a bad take. Each reaction is pinned to the moment in the video when it was thrown, and it rains down the page background at that moment. That happens for viewers watching live and for anyone who watches later. Each viewer can switch reactions off.

## Requirements

- **Any standard emoji** can be thrown. 🍅 is just the obvious example.
- **Pinned to video time.** A reaction plays when a viewer's playhead reaches the time it was thrown.
- **Limits per person:** at most 1 reaction per second, and at most 50 per video. One person can't flood the screen, but when lots of people throw at the same moment, the downpour should be obvious.
- **Can be switched off.** Each viewer has a "Show reactions" switch so reactions don't disrupt their viewing.

## Where reactions go: behind the player, never in front

YouTube forbids drawing anything over the embedded player. From [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), under "Overlays and frames":

> You must not display overlays, frames, or other visual elements in front of any part of a YouTube embedded player, including player controls.

[Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.I.6 adds that clients must not *"modify, build upon, or block any portion or functionality of a YouTube player."* There's no exception for small, short or semi-transparent effects.

So reactions are part of the page **background**. Emoji fall from the top of the stage to the bottom on a layer stacked *underneath* everything else on the stage. The player is opaque, so a drop that passes behind it is hidden for that stretch. Nothing is ever painted on top of the video or its controls, and nothing catches clicks over it.

- **Gutters.** With reactions on, wide screens shrink the player slightly, up to 96px on each side (`.reactions-on .player` in `styles.css`), so the rain has somewhere to be seen. Drops pick a horizontal spot in the strips left and right of the player, weighted by width. If there are no strips (phones, narrow windows), they fall anywhere and show above and below the player. Turning reactions off gives the full width back.
- **No aiming.** An earlier design had throwers aim at a spot in a "splash zone" around the player. Rain falls at random positions instead, which is simpler and needs no per-reaction position data.
- **Player size.** The gutters never shrink the player below the 200×200 minimum (compliance item 6). They're zero below 900px of viewport width.

## Data

```ts
interface Reaction {
  id: string;
  videoId: string;
  userId: string;
  emoji: string;
  videoTime: number; // seconds; required
  createdAt: number;
}
```

- **Anonymous.** Reactions don't store names or avatars, which keeps them clear of the 30-day limit on stored YouTube data (compliance item 3). Viewers only ever receive `{ id, emoji, videoTime }`.
- **Storage.** A second Cosmos container, `reactions`, partitioned on `/videoId` like `messages` (`azurerm_cosmosdb_sql_container.reactions` in `infra/main.tf`). It can be renamed with `COSMOS_REACTIONS_CONTAINER`. Without Cosmos, reactions are kept in memory.
- **`ReactionStore`** in `server/src/store.ts` has memory and Cosmos versions, with `add`, `forVideo(videoId)` and `countByUser(videoId, userId)`.
- **Deletion.** Any "delete my data" flow (compliance item 4) must delete reactions too.

## Server (`server/src/chat.ts`)

The `react` event (`{ emoji, videoTime }`) checks that:

- `emoji` is exactly one grapheme (`Intl.Segmenter`), and is `\p{Extended_Pictographic}`, a flag (two regional indicators) or a keycap such as 1️⃣;
- `videoTime` is a valid time;
- this socket hasn't thrown in the last second;
- the user has used fewer than 50 reactions on this video, counted from the store so the quota survives restarts and covers every tab.

On failure it acks `{ error }`. Otherwise it saves the reaction, sends `reaction` to the rest of the room, and acks `{ ok, reaction }`.

The quota is a quiet backstop against flooding, not a budget to spend, so the remaining count is never sent to clients or shown. Someone who hits it just sees "You've reached the reaction limit for this video." when they try to throw another.

On join, the server sends `reactions`: every reaction on the video, uncapped.

## Web

- **Replay** (`Watch` in `App.tsx`). The client keeps the room's reactions sorted by `videoTime`. On each player tick (~0.5s), it drops every reaction between the previous playhead and the current one, but only during normal forward playback. A jump of more than 2.5s counts as a seek and plays nothing, so seeking doesn't set off a burst of everything skipped.
- **Live.** Your own reaction drops as soon as the server accepts it. Other viewers' reactions arrive over the socket. If one is ahead of your playhead, replay plays it when you get there. If it's up to 3s behind you, it drops right away, so a room watching together still sees each other's reactions when their playheads drift a little. Anything further behind waits for a rewatch.
- **Throwing** (`ReactionBar.tsx`). Under the player there are quick picks (🍅 🥚 💩 ❤️ 😂 👏) and a "+" for any other emoji. On desktop, "+" opens a searchable picker (`EmojiPicker.tsx`, using `emoji-picker-element`). The library loads on first open, and its emoji data is served from our own `/assets` rather than a CDN. On touch devices, "+" opens a field that raises the system emoji keyboard, and an emoji is thrown as soon as it's tapped. The buttons rest for 1s after each throw to match the server's limit.
- **Animation** (`Rain.tsx`). Drops are plain DOM nodes animated with CSS keyframes. Each has a random size, drift, spin and duration, and is removed when its animation ends. At most 150 are on screen at once, purely for performance. With `prefers-reduced-motion`, drops fade in and out in place instead of falling.
- **Hotspots** (`hotspots()` in `reactions.ts`, drawn by `Timeline.tsx`). Under the timeline bar, busy moments show their most-thrown emoji, bigger and brighter the busier they are. Clicking one jumps to 2s before the burst, so it rains on the way in. The video is cut into 100 equal slices of time. Slicing never depends on screen size, so every viewer sees the same hotspots. A slice counts as a hotspot when it has at least 10% of the busiest slice's reactions. So a single reaction on a quiet video shows up, but one stray reaction next to a burst of thousands doesn't. The threshold is measured against the peak rather than the total, so a long video with reactions spread across it still shows its highlights. Busy slices with at most two quiet slices between them merge into one hotspot, and its tooltip shows the combined count. The only per-screen difference is on very narrow timelines (phones): when two hotspots would sit closer than 24px, only the stronger one is drawn.
- **Switch.** "Show reactions" is on by default. It's saved in `localStorage` under `balcony.showReactions`, with reads and writes in try/catch. When it's off, the rain layer, the gutters and the hotspot row go away, but you can still throw.

## Most reacted this week

The landing page (after sign-in, with no video open) lists the 5 videos with the most reactions *thrown* in the last 7 days. That's counted by `createdAt`, not by where in the video they land.

- **Query.** `ReactionStore.countsSince(since)` runs `SELECT c.videoId, c.emoji, COUNT(1) ... GROUP BY c.videoId, c.emoji` across partitions. That returns one row per video and emoji, not one per reaction. `rankMostReacted()` adds the rows up into totals and keeps each video's top 3 emoji. Ties are broken by code point and video ID so the order is stable.
- **Caching.** Everyone shares one result for 5 minutes, so the cross-partition query runs at most 12 times an hour however many people open the page.
- **Titles.** They come from YouTube's oEmbed endpoint (no API key or OAuth) and are kept in memory only, for 6 hours. A video YouTube won't describe, for example because it's private or deleted, still appears as "Untitled video".

## Open questions

- **Volume.** There's a cap per person but no cap per video, so a popular video could collect thousands of reactions, all sent on join. That might call for loading them in windows around the playhead.
- **Undo.** Can people take back their own reaction, and does that give them back one of their 50?
- **Emoji rendering.** Emoji are drawn by each viewer's own system, so the same reaction looks different across platforms. That's probably fine.
