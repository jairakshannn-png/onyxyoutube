# ONYX Terminal

A terminal-style, privacy-focused YouTube frontend powered by the public **Invidious API**. The browser talks only to this zero-dependency Node server. The server fetches metadata, comments, thumbnails, and media from configurable Invidious instances.

## Features

- Trending and popular feeds
- Video, channel, and playlist search
- Video playback through the app's own media proxy
- Comments, related videos, channel pages, and playlists
- Local favourites, subscriptions, and watch history
- Keyboard navigation and terminal commands
- Responsive terminal UI with no external frontend libraries or fonts
- Invidious instance failover, caching, request timeouts, and graceful shutdown
- Render Blueprint and `/healthz` endpoint

## Run locally

```bash
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

Node.js 20 or newer is required. No third-party npm packages are needed.

## Flat file layout

Every project file sits in this one folder. There are no `src`, `public`, or nested application directories. Upload or push the files exactly as supplied.

```text
.env.example
.gitignore
LICENSE
README.md
app.js
index.html
integration.test.js
package.json
render.yaml
server.js
server.test.js
style.css
```

## Deploy to Render

### Blueprint method

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint**.
3. Select the repository.
4. Render reads `render.yaml` and creates the web service.
5. After deployment, open the generated `onrender.com` address.

### Manual method

- Runtime: `Node`
- Build command: `npm run check`
- Start command: `npm start`
- Health check path: `/healthz`

Set these environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `INVIDIOUS_INSTANCE` | `https://inv.nadeko.net` | Primary Invidious server |
| `INVIDIOUS_FALLBACKS` | `https://invidious.nerdvpn.de` | Comma-separated backup servers |
| `REGION` | `SG` | Trending/search region |
| `REQUEST_TIMEOUT_MS` | `12000` | Metadata request timeout |
| `CACHE_TTL_MS` | `300000` | Metadata cache lifetime |
| `MEDIA_PROXY` | `true` | Proxy video bytes through ONYX |

## Terminal commands

- `:home`
- `:trending`
- `:popular`
- `:history`
- `:favorites`
- `:clear history`
- `:clear favorites`
- `:help`

You can also paste a regular YouTube or `youtu.be` video URL into the search bar.

## Invidious reliability

Public Invidious instances can become unavailable, rate-limit cloud hosts, or temporarily lose video playback. Keep at least two trusted instances configured. For the most reliable deployment, use your own Invidious instance and set `INVIDIOUS_INSTANCE` to its HTTPS URL.

The frontend deliberately does not include user accounts. Favourites, subscriptions, and history are stored in the browser's `localStorage`.

## Security notes

- Upstream hostnames are set only through server environment variables.
- Media proxy targets must use HTTPS.
- IDs and query inputs are validated and length-limited.
- The app sends a restrictive Content Security Policy.
- No arbitrary URL proxy endpoint is exposed.

## Attribution

ONYX Terminal is an independent frontend that uses the Invidious API. It does not copy the Invidious server code and is not affiliated with YouTube or the Invidious project.
