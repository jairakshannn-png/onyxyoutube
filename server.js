import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { Innertube, UniversalCache } from 'youtubei.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
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

app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));

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
app.get('/api/stream/:id', async (req, res) => {
  let settled = false;
  const timeout = setTimeout(() => {
    if (!settled && !res.headersSent) {
      settled = true;
      res.status(504).json({
        error:
          'YouTube did not respond in time. This often means the server\'s ' +
          'IP is being rate-limited/blocked by YouTube — common on cloud ' +
          'hosts. Check the server logs for the underlying error.',
      });
    }
  }, 15000);

  try {
    const yt = await getClient();
    const webStream = await yt.download(req.params.id, {
      type: 'video+audio',
      quality: 'best',
      format: 'mp4',
    });

    clearTimeout(timeout);
    if (settled) return;

    settled = true;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-store');

    const nodeStream = Readable.fromWeb(webStream);
    nodeStream.on('error', (streamErr) => {
      console.error('[/api/stream/:id] mid-stream error', streamErr);
      res.destroy();
    });
    nodeStream.pipe(res);
  } catch (err) {
    clearTimeout(timeout);
    console.error('[/api/stream/:id]', err);
    if (!settled && !res.headersSent) {
      settled = true;
      res
        .status(502)
        .json({ error: 'Could not stream this video.', detail: String(err?.message || err) });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Onyx is running → http://localhost:${PORT}`);
});
