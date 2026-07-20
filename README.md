# Onyx

A self-hosted, black-themed, ad-free frontend for YouTube — same video
backend, completely different UI. Architecturally this is the same idea as
[Invidious](https://github.com/iv-org/invidious): one server that talks to
YouTube on your behalf and hands your browser back a clean JSON API and a
custom UI, so the ads, tracking scripts, and YouTube's own frontend code
never load in your browser at all.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## How it works

- **`server.js`** — an Express server. It's the only thing that ever talks to
  YouTube. It uses [`youtubei.js`](https://github.com/LuanRT/YouTube.js), a
  library that speaks YouTube's internal "InnerTube" API (the same API
  youtube.com's own web client uses), to fetch the trending feed, run
  searches, load video metadata, and stream video/audio bytes. It reshapes
  all of that into a small, stable JSON contract in `/api/*`.
- **`public/`** — a plain HTML/CSS/JS frontend with a hash-based router
  (`#/`, `#/search?q=`, `#/watch?v=`). It never talks to youtube.com; it only
  ever calls this server's own `/api/*` routes, including for video
  playback — `/api/stream/:id` pipes the video bytes through your server, so
  the browser's network tab shows only requests to your own host.

## Why this isn't a generic "paste any URL" tunnel

If you've seen general-purpose unblocking proxies (fetch a page server-side,
rewrite every link so it stays inside the proxy, hand back a look-alike
page) — that pattern doesn't actually work for YouTube playback. YouTube's
video bytes are served from signed, session-bound `googlevideo.com` URLs;
a generic rewriting proxy has nothing to rewrite them *into*, and even
projects built around that pattern typically fall back to YouTube's own
embeddable player for video specifically, because there's no way around it
without speaking YouTube's real API. So that's what Onyx does directly,
server-side, from the start — it's the only approach that actually plays
video through your own frontend.

## Honest limitations

- **YouTube's internal API isn't public or stable.** It changes without
  notice, and `youtubei.js` sometimes lags behind for a few days after a
  breaking change. If a route in `server.js` starts throwing, `npm update
  youtubei.js` first.
- **Terms of service.** Using an unofficial client to access YouTube's
  backend, instead of youtube.com or the official API, sits outside
  YouTube's ToS — the same territory Invidious, Piped, and NewPipe are in.
  None of them are "hacking" YouTube (no auth is bypassed, no DRM is
  broken — everything fetched is the same public data youtube.com's own
  page requests), but it's worth knowing before you deploy this somewhere
  public rather than running it for yourself.
- **No login, no personalized feed, no comments/upload/history** in this
  version — it only covers browsing, search, and playback. All of those are
  addable the same way: add a route in `server.js` that calls the matching
  `youtubei.js` method, then a render function in `app.js`.
- **Single quality tier.** `/api/stream/:id` always requests `quality: 'best'`
  muxed video+audio. If you want a quality picker, `yt.getInfo(id)` exposes
  the full `adaptive_formats` list — you'd add an `itag` query param to
  `/api/stream/:id` and let the frontend choose.

## Design

True-black background, a cold ice-blue accent (`#6fd6ff`) instead of
YouTube's red, Space Grotesk for titles, JetBrains Mono for every piece of
metadata (durations, view counts, timestamps) so the interface reads a
little like a terminal/log rather than a typical media app. All of it lives
in CSS custom properties at the top of `public/style.css` if you want to
retheme it.
