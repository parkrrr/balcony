# Timed reactions

**Status:** planned, not built.

Viewers throw emoji at the screen, for example a 🍅 at a bad take. Each reaction is pinned to the moment in the video when it was thrown. Anyone who watches later, or is behind in the video, sees it fly at exactly that point. Each viewer can switch reactions off.

## Requirements

- **Any standard emoji** can be thrown. 🍅 is just the obvious example.
- **Pinned to video time.** A reaction plays when a viewer's playhead reaches the time it was thrown, for viewers who are watching live and for anyone who watches later.
- **Aimed.** The thrower chooses where it lands, within the limits in [Where reactions can go](#where-reactions-can-go).
- **Limits per person:** at most 1 reaction per second, and at most 50 per video. One person can't flood the screen, but when lots of people throw at the same moment, the pile-up should be obvious.
- **Can be switched off.** Each viewer has a "Show reactions" switch so reactions don't disrupt their viewing.

## Where reactions can go

YouTube forbids drawing anything over the embedded player. From [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), under "Overlays and frames":

> You must not display overlays, frames, or other visual elements in front of any part of a YouTube embedded player, including player controls.

[Developer Policies](https://developers.google.com/youtube/terms/developer-policies) III.I.6 adds that clients must not *"modify, build upon, or block any portion or functionality of a YouTube player."* There's no exception for small, short or semi-transparent effects. So:

- Reactions never land on, or fly across, the video. Their flight paths have to stay outside the player's rectangle too.
- Aiming can't use a click-catching layer over the player, because an invisible layer is still a "visual element in front of" the player.

Instead, the player is treated as a stage, and reactions hit everything around it:

- **Splash zone.** On wide screens the player sits inside a margin, styled as curtains or a proscenium. Reactions fly up from the audience side, splat in the margin next to the screen, and slide down.
- **Aim along the edges.** The thrower clicks a spot in the splash zone, for example the top-left corner of the screen. The landing spot is stored as `{side: "top" | "right" | "bottom" | "left", offset: 0..1}` along that edge, so it stays correct at any player size.
- **On the timeline.** Each reaction also pops above the timeline bar at its time. This is the main view on phones, which have no room for a splash zone. Phones also get a short strip of recent reactions under the player.
- **Player size.** The splash zone must never shrink the player below the 200×200 minimum (compliance item 6).

## Design

### Data

```ts
interface Reaction {
  id: string;
  videoId: string;
  userId: string;
  emoji: string;
  videoTime: number;                                // seconds; required
  side: "top" | "right" | "bottom" | "left";
  offset: number;                                   // 0..1 along that side
  createdAt: number;
}
```

- **No stored names or avatars.** Reactions are anonymous on screen, so they leave out the `name` and `avatar` that chat messages store. That keeps them clear of the 30-day limit on stored YouTube data (compliance item 3). If "who threw this" is wanted later, look the name up live by `userId`.
- **Storage.** A second Cosmos container, `reactions`, partitioned on `/videoId` like `messages`. That's one more `azurerm_cosmosdb_sql_container` in `infra/main.tf`, at no fixed cost on serverless.
- **`ReactionStore`.** Memory and Cosmos versions, next to `MessageStore` in `server/src/store.ts`. It provides `add`, `forVideo(videoId)` and `countByUser(videoId, userId)`.
- **Deletion.** Any "delete my data" flow (compliance item 4) must delete reactions too.

### Server (`server/src/chat.ts`)

A new `react` event checks four things:

- `emoji` is exactly one grapheme, checked with `Intl.Segmenter`. It must match `\p{Extended_Pictographic}` or be a flag (a pair of regional indicators).
- `side` is one of the four sides, and `offset` is between 0 and 1.
- **Rate:** the sender has thrown no more than 1 reaction per second, enforced per user the same way chat's rate limit is.
- **Quota:** the sender has no more than 50 reactions on this video. This is checked against `countByUser` in the store, not memory, so it survives restarts.

If a check fails, the server acks an error such as "You've used all 50 reactions for this video". Otherwise it saves the reaction, relays it to the room, and acks with the sender's remaining quota.

On join, the server sends the video's reactions along with chat history. Unlike chat history, they aren't capped at 100.

### Web

- **Replay.** The client keeps the room's reactions sorted by `videoTime`. On each player tick, it plays every reaction whose time falls between the previous playhead and the current one, during normal forward playback only. Seeking, including clicking someone on the timeline, doesn't trigger a burst of everything skipped.
- **Live.** A reaction you throw plays for you immediately. Everyone else gets it over the socket, and it plays when their playhead reaches that time. Anyone already past that point sees it only on the timeline.
- **Throwing.** A bar under the player has quick picks (🍅 🥚 💩 ❤️ 😂 👏) plus a full emoji picker, and shows how many reactions you have left (for example "38 left"). On wide screens, choosing an emoji arms aim mode: the splash zone highlights and the cursor becomes a crosshair, while the player itself stays untouched. The next click in the zone throws the emoji, and Esc cancels. On phones, the emoji goes straight onto the timeline at the current time.
- **Animation.** CSS keyframes in a layer clipped to the splash zone, with `pointer-events: none` except while aiming.
- **Switch.** "Show reactions" is on by default and saved in `localStorage`, with reads and writes in try/catch. When it's off, nothing animates in the splash zone or on the timeline. You can still throw reactions.

## Open questions

- **Volume.** There's a cap per person but no cap per video, so a popular video could collect thousands of reactions. That might call for loading them in windows around the playhead, or capping how many animate at once purely for performance, while keeping the pile-up visible.
- **Undo.** Can people take back their own reaction, and does that give them back one of their 50?
- **Emoji rendering.** Emoji are drawn by each viewer's own system, so the same reaction looks different across platforms. That's probably fine.
- **Splash zone size.** How much margin can the layout give up on mid-size screens before the video gets too small?
