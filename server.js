// Onyx — a black, ad-free frontend that sits in front of YouTube's own backend.
//
// Architecture (same idea as Invidious): this server holds the only connection
// to YouTube. It talks to YouTube's internal "InnerTube" API using the
// youtubei.js library, reshapes the response into a small clean JSON contract,
// and the browser only ever talks to THIS server — never to youtube.com
// directly. Video/audio bytes are streamed through this server too, so the
// browser's network tab never shows a youtube.com or googlevideo.com request.
//
// This is intentionally NOT a generic "paste any URL" tunneling proxy.
// A generic rewriting proxy can't relay YouTube's actual video bytes anyway —
// those come from signed, session-bound googlevideo.com URLs — so the only
// approach that actually plays video is to speak YouTube's own API from the
// server, like Invidious does. That's what this file does.
//
// Heads up: YouTube changes its internal API without notice. When that
// happens, youtubei.js usually ships an update within a few days. If
// something here throws, `npm update youtubei.js` first before debugging.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { Innertube, UniversalCache } from 'youtubei.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// --- One shared InnerTube client, created lazily on first request ---
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = Innertube.create({
      cache: new UniversalCache(false),
      generate_session_locally: true,
    });
  }
  return clientPromise;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Helpers ---------------------------------------------------------------

// Reshape whatever youtubei.js gives back for a "video in a list" into one
// flat, stable shape the frontend can rely on regardless of upstream changes.
function summarize(item) {
  if (!item) return null;
  const id = item.id || item.video_id;
  if (!id) return null;
  return {
    id,
    title: text(item.title),
    author: item.author?.name || item.channel?.name || null,
    channelId: item.author?.id || item.channel?.id || null,
    thumbnail: firstThumb(item) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    duration: text(item.duration) || text(item.length_text) || null,
    views: text(item.short_view_count) || text(item.view_count) || null,
    published: text(item.published) || null,
  };
}

function text(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  return node.text ?? null;
}

function firstThumb(item) {
  const arr = item.thumbnails || item.thumbnail || null;
  if (Array.isArray(arr) && arr.length) return arr[arr.length - 1].url;
  return null;
}

function safeList(maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [];
}

// --- Routes ------------------------------------------------------------

// Home feed (YouTube's public "trending" feed, no account needed)
app.get('/api/home', async (req, res) => {
  try {
    const yt = await getClient();
    const trending = await yt.getTrending();
    const videos = safeList(trending.videos)
      .filter((v) => v.type === 'Video')
      .map(summarize)
      .filter(Boolean);
    res.json({ videos });
  } catch (err) {
    console.error('[/api/home]', err);
    res.status(502).json({ error: 'Could not load the home feed right now.' });
  }
});

// Search
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  try {
    const yt = await getClient();
    const results = await yt.search(q, { type: 'video' });
    const videos = safeList(results.videos || results.results)
      .filter((v) => v.type === 'Video')
      .map(summarize)
      .filter(Boolean);
    res.json({ query: q, videos });
  } catch (err) {
    console.error('[/api/search]', err);
    res.status(502).json({ error: 'Search failed.' });
  }
});

// Single video: metadata + related videos
app.get('/api/video/:id', async (req, res) => {
  try {
    const yt = await getClient();
    const info = await yt.getInfo(req.params.id);
    const basic = info.basic_info || {};

    const related = safeList(info.watch_next_feed)
      .filter((v) => v.type === 'Video')
      .slice(0, 20)
      .map(summarize)
      .filter(Boolean);

    res.json({
      id: basic.id || req.params.id,
      title: basic.title || null,
      author: basic.author || basic.channel?.name || null,
      channelId: basic.channel_id || basic.channel?.id || null,
      views: basic.view_count ?? null,
      likes: basic.like_count ?? null,
      duration: basic.duration ?? null,
      published: basic.publish_date || basic.published || null,
      description: basic.short_description || '',
      thumbnail:
        firstThumb(basic) || `https://i.ytimg.com/vi/${req.params.id}/hqdefault.jpg`,
      related,
    });
  } catch (err) {
    console.error('[/api/video/:id]', err);
    res.status(502).json({ error: 'Could not load this video.' });
  }
});

// Media proxy — the server fetches the stream from YouTube and pipes the
// bytes straight through. The browser only ever requests this URL.
app.get('/api/stream/:id', async (req, res) => {
  try {
    const yt = await getClient();
    const webStream = await yt.download(req.params.id, {
      type: 'video+audio',
      quality: 'best',
      format: 'mp4',
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');
    Readable.fromWeb(webStream).pipe(res);
  } catch (err) {
    console.error('[/api/stream/:id]', err);
    res.status(502).json({ error: 'Could not stream this video.' });
  }
});

app.listen(PORT, () => {
  console.log(`Onyx is running → http://localhost:${PORT}`);
});
