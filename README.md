# Balcony

The best seats for watching YouTube together ([balcony.chat](https://balcony.chat)). Chat rooms for YouTube videos. Each video ID is its own room: the video plays through the YouTube IFrame API, chat runs alongside it (newest at the bottom), and a timeline under the player shows where every viewer is. Click someone on the timeline, or a timestamp on a chat message, to jump there.

Rooms use YouTube's own URL shape, so `https://<site>/watch?v=dQw4w9WgXcQ` works like the youtube.com link.

## How it works

```
web/      React + Vite. Player (IFrame API), Timeline, Chat; one Socket.IO connection per video.
server/   Node + Express + Socket.IO. Google sign-in, chat relay/history, position relay. Serves web/dist in production.
infra/    OpenTofu for the Azure resources, deployed into the alz-parkrrr "balcony" landing zone.
```

- **Sign-in** is Google OAuth (authorization code + PKCE) with the `youtube.readonly` scope, which is only used to read the viewer's channel name and avatar. The session is a signed, httpOnly cookie, and the server keeps no session state.
- **Premium / ads**: the IFrame player can't be handed an OAuth token. It plays as whichever Google account the browser is signed in to on youtube.com, so Premium applies when the viewer is signed in there and the browser allows YouTube's cookies in embeds. Signing in to Balcony doesn't change playback.
- **Positions**: each client reports `{t, playing, rate}` when it changes and every 5 seconds as a heartbeat. The server relays reports to the room, and clients estimate where everyone is between reports. Nothing about positions is stored.
- **History**: the last 100 messages per video, in Cosmos DB (container partitioned on `/videoId`). With no `COSMOS_ENDPOINT` set, history is kept in memory.
- **Reactions**: emoji pinned to a moment in the video, replayed for everyone who reaches it. Stored in a second Cosmos container, `reactions`, or in memory without Cosmos.

## Local development

1. Create an OAuth client in the Google Cloud console (*Web application*), add `http://localhost:5173/auth/callback` as a redirect URI, and enable the **YouTube Data API v3**.
2. `cp server/.env.example server/.env` and fill it in.
3. `npm install && npm run dev`, then open http://localhost:5173.

Run `npm test` for the server tests (session handling plus Socket.IO rooms, chat and positions against a real server) and `npm run typecheck` to typecheck both packages.

## Azure

Everything goes into `alz-balcony-rg`, created by the landing zone (`alz-parkrrr/workloads/balcony.yaml`):

| Resource | Notes |
| --- | --- |
| Container Apps environment + app | VNet-integrated in `alz-balcony-snet`, public ingress, Consumption profile, scales to zero |
| Cosmos DB (serverless) | Public access off, local (key) auth off, private endpoint in `alz-pep-snet`, Entra data-plane role for the app |
| Container Registry (Basic) | Public endpoint (private endpoints need Premium), admin user off, AcrPull via managed identity |
| User-assigned identity | The app's identity for ACR pulls and Cosmos access |

Logs go to the platform Log Analytics workspace. The Google client secret and the generated session secret are stored as Container Apps secrets.

### First deploy

1. **Landing zone**: merge the balcony workload PR in `alz-parkrrr` ([#4](https://github.com/parkrrr/alz-parkrrr/pull/4)). It registers `Microsoft.App`; adds the hub private DNS zone, the delegated subnet, the deploy identity and its roles; and exempts `alz-balcony-managed-rg` from the `managedBy` tag policy.
2. **GitHub**: in `parkrrr/balcony`, create an environment named `azure` with these secrets: `AZURE_CLIENT_ID` (`deploy_client_id` from `tofu output landing_zones`), `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, and `GOOGLE_CLIENT_SECRET`.
3. **Google**: put the OAuth client ID in `infra/terraform.tfvars`.
4. Push to `main`. CI tests, creates the registry on the first run, builds and pushes the image, then applies.
5. Add the `oauth_redirect_uri` output to the Google OAuth client's redirect URIs.

`youtube.readonly` is a *sensitive* scope. While the Google OAuth consent screen is in **Testing**, only listed test users (up to 100) can sign in. Opening it to everyone requires Google's app verification.

### Cost

Roughly $13–18/month at low traffic: about $7.30 for the Cosmos private endpoint, $5 for ACR Basic, $0.50 for the DNS zone, and pennies for serverless Cosmos. Container Apps is mostly covered by the monthly free grant while the app scales to zero. This counts against the subscription's $50 budget.

### Limits

- `max_replicas` is 1 because rooms live in process memory. To scale out, add a Socket.IO adapter (Redis, or Azure Web PubSub for Socket.IO).
- With `min_replicas = 0`, the first visitor after an idle period waits a few seconds for a cold start.

## Docs

- [YouTube API compliance](docs/youtube-compliance.md): what still has to change before launch.
- [Timed reactions](docs/timed-reactions.md): emoji that viewers throw at a moment in the video, raining down the page background behind the player.
