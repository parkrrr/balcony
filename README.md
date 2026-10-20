# Balcony

The best seats for watching YouTube together ([balcony.chat](https://balcony.chat)). Chat rooms for YouTube videos. Each video ID is its own room: the video plays through the YouTube IFrame API, chat runs alongside it (newest at the bottom), and a timeline under the player shows where every viewer is. Click someone on the timeline, or a timestamp on a chat message, to jump there.

Rooms use YouTube's own URL shape, so `https://<site>/watch?v=dQw4w9WgXcQ` works like the youtube.com link.

## How it works

```
web/      React + Vite. Player (IFrame API), Timeline, Chat; one Socket.IO connection per video.
server/   Node + Express + Socket.IO. Sign-in, chat relay/history, position relay. Serves web/dist in production.
infra/    OpenTofu for the Azure resources, deployed into the alz-parkrrr "balcony" landing zone.
```

- **Sign-in** is, for now, on the honor system. Viewers type a display name, or take a random one like "Velvet Owl". Each sign-in is a fresh guest identity (`guest:<uuid>`), and names don't have to be unique. The session is a signed, httpOnly cookie, and the server keeps no session state.
- **Google sign-in** (OAuth code + PKCE, with the `youtube.readonly` scope for the viewer's channel name and avatar) is parked until Google verifies the app for that scope. The code is still in `server/src/auth.ts`. Setting `GOOGLE_SIGN_IN=on`, along with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, adds an "Or sign in with Google" link to the sign-in screen again.
- **Premium / ads**: the IFrame player can't be handed an OAuth token. It plays as whichever Google account the browser is signed in to on youtube.com, so Premium applies when the viewer is signed in there and the browser allows YouTube's cookies in embeds. Signing in to Balcony doesn't change playback.
- **Positions**: each client reports `{t, playing, rate}` when it changes and every 5 seconds as a heartbeat. The server relays reports to the room, and clients estimate where everyone is between reports. Nothing about positions is stored.
- **History**: the last 100 messages per video, in Cosmos DB (container partitioned on `/videoId`). With no `COSMOS_ENDPOINT` set, history is kept in memory. Messages are deleted 30 days after they're sent: by the container's `default_ttl` in Cosmos, and by the store itself in memory.
- **Reactions**: emoji pinned to a moment in the video, replayed for everyone who reaches it. Stored in a second Cosmos container, `reactions`, or in memory without Cosmos.
- **Search bar**: the top bar is the same on every page. Paste a YouTube link or ID and press the arrow to open its room, or roll the 🎲 for a random one.
- **Most reacted**: the landing page is just this list: the 5 videos with the most reactions thrown in the last 7 days, each with its top emoji (`/api/most-reacted`, `server/src/mostReacted.ts`). Titles and channel names come from YouTube's public oEmbed endpoint and are cached in memory for 6 hours. Thumbnails load straight from `i.ytimg.com`. The list is refreshed at most every 5 minutes, because each refresh is a cross-partition Cosmos query.
- **Random video**: the 🎲 in the search bar opens a video picked uniformly from every video that has ever had a reaction (`/api/random-video`, `server/src/randomVideo.ts`). On a video page it never picks the video you're watching (`?exclude=<id>`). Reaction counts don't matter: a video with one reaction is as likely as one with thousands. The list of reacted videos is cached for 5 minutes, but each click makes a fresh pick.

## Local development

1. `cp server/.env.example server/.env` and set `SESSION_SECRET`.
2. `npm install && npm run dev`, then open http://localhost:5173.

To try Google sign-in locally, create an OAuth client in the Google Cloud console (*Web application*). Add `http://localhost:5173/auth/callback` as a redirect URI, enable the **YouTube Data API v3**, and set the `GOOGLE_*` variables in `server/.env`.

Run `npm test` for the server tests (sessions and guest sign-in, plus Socket.IO rooms, chat, positions and reactions against a real server) and `npm run typecheck` to typecheck both packages.

## Azure

Everything goes into `alz-balcony-rg`, created by the landing zone (`alz-parkrrr/workloads/balcony.yaml`):

| Resource | Notes |
| --- | --- |
| Container Apps environment + app | VNet-integrated in `alz-balcony-snet`, public ingress, Consumption profile, scales to zero |
| Cosmos DB (serverless) | Public access off, local (key) auth off, private endpoint in `alz-pep-snet`, Entra data-plane role for the app |
| Container Registry (Basic) | Public endpoint (private endpoints need Premium), admin user off, AcrPull via managed identity |
| User-assigned identity | The app's identity for ACR pulls and Cosmos access |
| Application Insights | Stores its data in the platform Log Analytics workspace, with a 0.1 GB daily cap |

Logs go to the platform Log Analytics workspace. The Google client secret, the generated session secret and the Application Insights connection string are stored as Container Apps secrets.

**Telemetry.** The server sends requests, Cosmos DB calls, exceptions and metrics to Application Insights (`server/src/telemetry.ts`, using `@azure/monitor-opentelemetry`). It's loaded with `node --import` before the app, because ES modules can only be instrumented if the hooks are in place before they load. Socket.IO `join`, `chat` and `react` events show up as requests named `socket <event>` (`server/src/tracing.ts`). `position` events are too frequent to be worth recording, and `/healthz` probes and `/assets` files aren't recorded either. Sampling keeps at most 5 traces a second. Requests are named by path, never including the query string. Without `APPLICATIONINSIGHTS_CONNECTION_STRING` nothing is sent, so local runs and tests are unaffected.

### First deploy

1. **Landing zone**: merge the balcony workload PR in `alz-parkrrr` ([#4](https://github.com/parkrrr/alz-parkrrr/pull/4)). It registers `Microsoft.App`; adds the hub private DNS zone, the delegated subnet, the deploy identity and its roles; and exempts `alz-balcony-managed-rg` from the `managedBy` tag policy.
2. **GitHub**: in `parkrrr/balcony`, create an environment named `azure` with these secrets: `AZURE_CLIENT_ID` (`deploy_client_id` from `tofu output landing_zones`), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and `GOOGLE_CLIENT_SECRET`.
3. **Google**: put the OAuth client ID in `infra/terraform.tfvars`.
4. Push to `main`. CI tests, creates the registry on the first run, builds and pushes the image, then applies.
5. Add the `oauth_redirect_uri` output to the Google OAuth client's redirect URIs.

`youtube.readonly` is a *sensitive* scope. While the Google OAuth consent screen is in **Testing**, only listed test users (up to 100) can sign in. Opening it to everyone requires Google's app verification, which is why Google sign-in is currently off. Infra still passes the client ID and secret to the app, so turning it back on only needs a `GOOGLE_SIGN_IN = "on"` env var on the container app in `infra/main.tf`.

### Cost

Roughly $13–18/month at low traffic: about $7.30 for the Cosmos private endpoint, $5 for ACR Basic, $0.50 for the DNS zone, and pennies for serverless Cosmos. Container Apps is mostly covered by the monthly free grant while the app scales to zero. This counts against the subscription's $50 budget.

### Retention

| Data | Kept for | How |
| --- | --- | --- |
| Chat messages | 30 days | Cosmos `default_ttl` on `messages` |
| Reactions | Indefinitely | Fully anonymous: no user ID, name or avatar |
| Reaction quota counters | 30 days after the viewer's last reaction on that video | Cosmos `default_ttl` on `reaction-quotas`; keyed by a hash of the user ID |
| Cosmos backups | 8 hours | Periodic backup (every 4 hours, 8-hour retention), so deleted data is gone from backups within a day |
| Container images | Newest 5 | A CI step after each successful deploy deletes older tags |
| Inactive app revisions | Newest 5 | `max_inactive_revisions` on the container app |
| App logs | 30 days | The landing zone's Log Analytics workspace |
| Telemetry (Application Insights) | 30 days | Stored in the same workspace; IP addresses are masked |
| Sessions | 7 days | Signed cookie; nothing stored server-side |
| Video titles (most reacted) | 6 hours | In process memory only |

### Limits

- `max_replicas` is 1 because rooms live in process memory. To scale out, add a Socket.IO adapter (Redis, or Azure Web PubSub for Socket.IO).
- With `min_replicas = 0`, the first visitor after an idle period waits a few seconds for a cold start.

## Docs

- [YouTube API compliance](docs/youtube-compliance.md): what still has to change before launch.
- [Timed reactions](docs/timed-reactions.md): emoji that viewers throw at a moment in the video, raining down the page background behind the player.
