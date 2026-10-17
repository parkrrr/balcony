# YouTube API compliance

Gaps between Balcony (formerly ytchat) and the YouTube API Services policies, to close before go-live. Reviewed 2026-10-17 against:

- [Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
- [Branding Guidelines](https://developers.google.com/youtube/terms/branding-guidelines)
- [IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference)

**Google sign-in is off for now (2026-10-17).** Viewers sign in as guests with a display name they choose, so the app no longer calls the YouTube Data API or receives channel names and avatars. While that's true:

- Items 3 and 4 only cover messages already stored with YouTube channel names and avatars from before the switch. New messages carry guest names, which aren't YouTube data. The old messages still need the 30-day treatment (or deleting).
- Item 5 still applies, because the embedded player is itself a YouTube API Service. The parts about Google account data and revoking Google access don't apply.
- Everything about the player and branding (items 1, 2, 6 and 7) is unchanged.

When Google sign-in comes back (`GOOGLE_SIGN_IN=on`), all of the items below apply again in full.

## Must fix

### 1. Product name

The Branding Guidelines say: *"You must never use the YouTube name or any abbreviation, acronym, or variant of the word YouTube"* in an app's name. "YT" is an abbreviation, so "ytchat" has to go. The same rule covers domains: *"Do not register the YouTube trademarks as second-level domain names."* A descriptive tagline such as "a chat app for YouTube" is allowed.

**Fix:** choose a new name and domain. Then rename the UI text, the page `<title>`, the cookie names (`ytchat_session`, `ytchat_oauth`), the Azure resource names, the OAuth consent screen and the GitHub repo.

**Status (2026-10-17):** done, except the consent screen. The app is now **Balcony** (balcony.chat). The UI, title, cookies (`balcony_session`, `balcony_oauth`), packages, Azure and landing-zone names (`alz-balcony-*`) and the GitHub repo (`parkrrr/balcony`) are renamed. The app name on the Google OAuth consent screen still has to be changed by hand.

### 2. Logo and look

The logo is a red (`#ff3d3d`) rounded square with a white play triangle (`Logo` in `web/src/App.tsx`, the favicon in `web/index.html`), and the app uses YouTube's Roboto font. The guidelines ban *"marks, logos, slogans, or designs that are confusingly similar to the YouTube trademarks,"* including *"distinctive color combinations, typography, graphic designs, product icons."*

Developer Policies I.1 adds that clients *"must not mimic or replicate YouTube's core user experiences"* unless they *"add significant independent value."* The timeline and position sharing likely count as that value, but the `/watch?v=` URL shape and the YouTube-like styling make the app look closer to YouTube than it needs to.

**Fix:** a new logo that is neither a red play button nor a red rectangle, a different accent color and font, and possibly a URL scheme other than `/watch?v=`.

**Status (2026-10-17):** mostly done.
- **Logo:** now two people behind a balcony railing on gold.
- **Palette:** dark violet and gold, replacing YouTube's `#0f0f0f`/`#3ea6ff`/red dark theme.
- **Font:** the system font stack instead of Roboto.

The `/watch?v=` URL shape is still open.

### 3. Chat history keeps YouTube data longer than allowed

Every message saved to Cosmos contains `name` and `avatar` (`server/src/chat.ts`, `server/src/store.ts`). Those values are the channel title and thumbnail returned by the Data API. Policy III.E.4.c allows storing that data *"for no longer than 30 calendar days. After 30 calendar days, the API Client must either delete or refresh the stored data."*

**Status (2026-10-17):** fixed with the second option. The messages container has a 30-day `default_ttl`, so every message, with its name and avatar, is deleted 30 days after it's sent. Applying it also removed any existing messages that were already older than 30 days.

Options that were considered:

- Store only `userId`/`channelId` with each message. Keep names and avatars in a separate per-user record that expires after 30 days (Cosmos TTL), and show a placeholder once it's gone.
- Set a 30-day TTL on the messages container. This is simpler, but it means chat history only covers the last 30 days.

The in-memory store only lives as long as the process, so it's fine either way.

### 4. Delete data when access is revoked

III.D.2.3 and III.E.4.g require deleting a user's data after they revoke access: within 7 days if they revoke inside the app, and within 30 days if they revoke from Google's security settings page.

**Fix:**

- Add a "delete my data" action that removes the user's messages, or their stored display info under the first option in item 3.
- Revoke the Google token when the user deletes their data. Signing out on its own can stay as it is.
- A 30-day TTL from item 3 handles revocation from Google's security page, because the app has no other way to find out about it. *That TTL is now in place. The "delete my data" action is still missing. Reactions are anonymous, so it only needs to cover messages and reaction quota counters.*

### 5. Terms, privacy policy and revocation link

III.A.1 and III.A.2 require that, before using the app, users:

- see a link to the [YouTube Terms of Service](https://www.youtube.com/t/terms) and are told that using the app means agreeing to them;
- agree to the app's own privacy policy. It must cover what is collected (Google account ID, channel ID, channel name and avatar, chat messages, playback positions), that names and avatars are shown to other viewers, how long chat history is kept, and the session cookie;
- can see the [Google Privacy Policy](https://policies.google.com/privacy) and a link to revoke access at <https://security.google.com/settings/security/permissions> (III.A.2.h).

**Fix:** add a privacy policy page and link these from the sign-in card in `web/src/App.tsx`. Google also asks for a privacy policy URL and a homepage when verifying the sensitive `youtube.readonly` scope (see the README).

### 6. Player smaller than 200×200 on phones

The IFrame API requires: *"Embedded players must have a viewport that is at least 200px by 200px."* Below 900px wide, `.player` is full width at 16:9 inside 16px of padding, so a 375px phone gets a player about 343×193. The `max-height: calc(100vh - 220px)` rule also shrinks it on short windows.

**Fix:** give `.player` in `web/src/styles.css` a minimum width and height of 200px. Google recommends at least 480×270 for 16:9 players.

### 7. The error panel covers the player

[Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality), under "Overlays and frames", says:

> You must not display overlays, frames, or other visual elements in front of any part of a YouTube embedded player, including player controls.

The rule has no exceptions. When a video can't play, `.player-error` in `Player.tsx` draws a semi-transparent panel over the player. When the owner blocks embedding, that panel sits on top of YouTube's own "Video unavailable" screen.

**Fix:** show the message below the player, or remove the player and show the message in its place. Don't layer it on top.

This rule also limits features. Nothing the app draws can go on top of the player, even briefly or transparently. [Timed reactions](timed-reactions.md) fall on a background layer stacked underneath the player for this reason.

## Should fix

- **Scope justification.** `openid profile` already provides a name and picture. Google's OAuth policy asks for the narrowest scope that does the job, so the verification request has to explain why `youtube.readonly` is needed (to show the YouTube channel identity, including brand accounts). The fallback is to drop the scope and use the Google profile only.
- **Sign-in button text.** "Sign in with YouTube" suggests YouTube endorses the app, and the sign-in is actually Google's. Switch to "Sign in with Google" and follow [Google's sign-in branding guidelines](https://developers.google.com/identity/branding-guidelines). *The button text now reads "Sign in with Google". The button doesn't follow Google's sign-in button design yet.*
- **Reporting and moderation.** Viewers have no way to report or remove abusive chat messages. YouTube's API policies don't require it, but it matters for a public app with user-generated content shown next to YouTube videos.

## Already compliant

- Uses the official IFrame player without modifying it. The only thing drawn over it is the error panel, which item 7 covers.
- No autoplay, no background or audio-only playback, no ad blocking. Premium and ads follow the viewer's own youtube.com sign-in.
- Identifies the client to YouTube: sets `origin` in `playerVars`, and the `strict-origin-when-cross-origin` referrer policy sends the Referer header that embeds require (without it, playback fails with error 153).
- Never asks for or stores YouTube credentials (II.4).
- Uses the access token once, at sign-in, and discards it. Sessions last 7 days, which is inside the 30-day re-authorization window in III.E.4.b.
- Doesn't store playback positions.
- The landing page's "most reacted" list shows titles, channel names and thumbnails for the videos people react to most. Titles and channel names come from YouTube's oEmbed endpoint and live in process memory for at most 6 hours, inside the 30-day limit in III.E.4.c. They're never written to Cosmos. Each entry links to that video's room, where it plays in the official player.
