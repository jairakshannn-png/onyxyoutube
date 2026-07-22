import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

try { process.loadEnvFile?.(); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = __dirname;
const PORT = Number(process.env.PORT || 3000);
const REGION = String(process.env.REGION || 'SG').toUpperCase();
const REQUEST_TIMEOUT_MS = clampNumber(process.env.REQUEST_TIMEOUT_MS, 12_000, 2_000, 60_000);
const CACHE_TTL_MS = clampNumber(process.env.CACHE_TTL_MS, 300_000, 10_000, 3_600_000);
const MEDIA_PROXY = String(process.env.MEDIA_PROXY || 'true').toLowerCase() !== 'false';

const configuredInstances = unique([
  process.env.INVIDIOUS_INSTANCE || 'https://inv.nadeko.net',
  ...String(process.env.INVIDIOUS_FALLBACKS ?? 'https://invidious.nerdvpn.de')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
].map(normalizeInstance).filter(Boolean));

if (!configuredInstances.length) throw new Error('At least one valid HTTPS Invidious instance is required.');

let preferredInstance = configuredInstances[0];
const instanceFailures = new Map();
const cache = new Map();
const staticCache = new Map();

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed.' }, { Allow: 'GET, HEAD' });
    }

    if (url.pathname === '/healthz') {
      return sendJson(res, 200, {
        ok: true,
        service: 'onyx-terminal',
        activeInstance: hostname(preferredInstance),
        configuredInstances: configuredInstances.length,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (url.pathname === '/api/config') {
      return sendJson(res, 200, {
        service: 'onyx-terminal',
        region: REGION,
        activeInstance: hostname(preferredInstance),
        instanceCount: configuredInstances.length,
        mediaProxy: MEDIA_PROXY,
      });
    }

    if (url.pathname === '/api/home') return await handleHome(url, res);
    if (url.pathname === '/api/search') return await handleSearch(url, res);
    if (url.pathname === '/api/suggestions') return await handleSuggestions(url, res);
    if (url.pathname === '/api/image') return await handleImage(url, req, res);

    let match = url.pathname.match(/^\/api\/video\/([A-Za-z0-9_-]{11})$/);
    if (match) return await handleVideo(match[1], res);

    match = url.pathname.match(/^\/api\/comments\/([A-Za-z0-9_-]{11})$/);
    if (match) return await handleComments(match[1], url, res);

    match = url.pathname.match(/^\/api\/channel\/([A-Za-z0-9_-]{3,64})$/);
    if (match) return await handleChannel(match[1], res);

    match = url.pathname.match(/^\/api\/playlist\/([A-Za-z0-9_-]{10,100})$/);
    if (match) return await handlePlaylist(match[1], res);

    match = url.pathname.match(/^\/api\/media\/([A-Za-z0-9_-]{11})$/);
    if (match) return await handleMedia(match[1], url, req, res);

    match = url.pathname.match(/^\/api\/thumb\/([A-Za-z0-9_-]{11})\/([^/]+)$/);
    if (match) return await handleThumbnail(match[1], match[2], req, res);

    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'API route not found.' });
    return await serveFrontend(url.pathname, req, res);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const status = error instanceof UpstreamError ? 502 : Number(error.status || 500);
    const message = status >= 500 && !(error instanceof UpstreamError)
      ? 'The server hit an unexpected error.'
      : error.message;
    console.error(`[${req.method} ${url.pathname}]`, error);
    if (!res.headersSent) sendJson(res, status, { error: message, code: error.code || undefined });
    else res.destroy(error);
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`ONYX terminal listening on http://0.0.0.0:${PORT}`);
    console.log(`Invidious instances: ${configuredInstances.map(hostname).join(', ')}`);
  });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function handleHome(url, res) {
  const region = safeRegion(url.searchParams.get('region')) || REGION;
  const [trendingResult, popularResult] = await Promise.allSettled([
    invidiousJson(`/api/v1/trending?region=${region}`, { cacheKey: `trending:${region}`, ttl: 120_000 }),
    invidiousJson(`/api/v1/popular?region=${region}`, { cacheKey: `popular:${region}`, ttl: 120_000 }),
  ]);
  const trending = trendingResult.status === 'fulfilled' ? normalizeVideoList(trendingResult.value) : [];
  const popular = popularResult.status === 'fulfilled' ? normalizeVideoList(popularResult.value) : [];
  if (!trending.length && !popular.length) {
    const reason = [trendingResult, popularResult]
      .filter((item) => item.status === 'rejected')
      .map((item) => item.reason?.message)
      .filter(Boolean)
      .join(' | ');
    throw new UpstreamError(reason || 'No home feed was returned by the configured Invidious instances.');
  }
  return sendJson(res, 200, { region, trending, popular });
}

async function handleSearch(url, res) {
  const q = cleanText(url.searchParams.get('q'), 160);
  if (!q) return sendJson(res, 400, { error: 'Enter a search query.' });
  const params = new URLSearchParams({
    q,
    page: String(clampNumber(url.searchParams.get('page'), 1, 1, 100)),
    type: allowed(url.searchParams.get('type'), ['all', 'video', 'channel', 'playlist', 'movie', 'show'], 'video'),
    sort: allowed(url.searchParams.get('sort'), ['relevance', 'views'], 'relevance'),
    region: safeRegion(url.searchParams.get('region')) || REGION,
  });
  const date = allowed(url.searchParams.get('date'), ['hour', 'today', 'week', 'month', 'year'], '');
  const duration = allowed(url.searchParams.get('duration'), ['short', 'medium', 'long'], '');
  if (date) params.set('date', date);
  if (duration) params.set('duration', duration);
  const data = await invidiousJson(`/api/v1/search?${params}`, {
    cacheKey: `search:${params}`,
    ttl: 90_000,
  });
  return sendJson(res, 200, { query: q, page: Number(params.get('page')), results: normalizeSearchResults(data) });
}

async function handleSuggestions(url, res) {
  const q = cleanText(url.searchParams.get('q'), 100);
  if (!q) return sendJson(res, 200, { suggestions: [] });
  const data = await invidiousJson(`/api/v1/search/suggestions?q=${encodeURIComponent(q)}`, {
    cacheKey: `suggestions:${q.toLowerCase()}`,
    ttl: 300_000,
  });
  const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : Array.isArray(data) ? data : [];
  return sendJson(res, 200, { suggestions: suggestions.slice(0, 8).map(String) });
}

async function handleVideo(id, res) {
  return sendJson(res, 200, normalizeVideoDetails(await getVideo(id)));
}

async function handleComments(id, url, res) {
  const params = new URLSearchParams({ sort_by: allowed(url.searchParams.get('sort'), ['top', 'new'], 'top') });
  const continuation = cleanText(url.searchParams.get('continuation'), 2000);
  if (continuation) params.set('continuation', continuation);
  const data = await invidiousJson(`/api/v1/comments/${id}?${params}`, {
    cacheKey: continuation ? null : `comments:${id}:${params.get('sort_by')}`,
    ttl: 120_000,
  });
  return sendJson(res, 200, normalizeComments(data));
}

async function handleChannel(id, res) {
  const safeId = channelId(id);
  if (!safeId) return sendJson(res, 400, { error: 'Invalid channel ID.' });
  const [channel, videos] = await Promise.all([
    invidiousJson(`/api/v1/channels/${safeId}`, { cacheKey: `channel:${safeId}`, ttl: 300_000 }),
    invidiousJson(`/api/v1/channels/${safeId}/videos`, { cacheKey: `channel-videos:${safeId}`, ttl: 180_000 }),
  ]);
  return sendJson(res, 200, normalizeChannel(channel, videos));
}

async function handlePlaylist(id, res) {
  const safeId = playlistId(id);
  if (!safeId) return sendJson(res, 400, { error: 'Invalid playlist ID.' });
  const data = await invidiousJson(`/api/v1/playlists/${safeId}`, { cacheKey: `playlist:${safeId}`, ttl: 180_000 });
  return sendJson(res, 200, normalizePlaylist(data));
}

async function handleMedia(id, url, req, res) {
  const details = await getVideo(id);
  const stream = chooseMuxedStream(details?.formatStreams, cleanText(url.searchParams.get('itag'), 8));
  if (!stream?.url) return sendJson(res, 404, { error: 'No browser-compatible combined video/audio stream is available for this video.' });
  if (!MEDIA_PROXY) {
    res.statusCode = 302;
    res.setHeader('Location', stream.url);
    return res.end();
  }
  return proxyMedia(req, res, stream.url, stream.type || 'video/mp4');
}

async function handleImage(url, req, res) {
  const target = safeImageUrl(cleanText(url.searchParams.get('url'), 3000));
  if (!target) return sendJson(res, 400, { error: 'Invalid image URL.' });
  return proxyImageResponse(target, req, res);
}

async function handleThumbnail(id, file, req, res) {
  const allowedFiles = new Set(['default.jpg', 'mqdefault.jpg', 'hqdefault.jpg', 'sddefault.jpg', 'maxresdefault.jpg', '0.jpg', '1.jpg', '2.jpg', '3.jpg']);
  if (!allowedFiles.has(file)) return sendJson(res, 400, { error: 'Invalid thumbnail.' });
  return proxyImageResponse(new URL(`https://i.ytimg.com/vi/${id}/${file}`), req, res);
}

async function proxyImageResponse(target, req, res) {
  const headers = { 'user-agent': browserUserAgent(), accept: 'image/avif,image/webp,image/png,image/jpeg,image/*' };
  if (req.headers['if-none-match']) headers['if-none-match'] = req.headers['if-none-match'];
  const upstream = await fetchWithTimeout(target, { headers }, REQUEST_TIMEOUT_MS);
  res.statusCode = upstream.status;
  copyHeaders(upstream.headers, res, ['content-type', 'content-length', 'etag', 'last-modified']);
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (req.method === 'HEAD' || !upstream.body) return res.end();
  return Readable.fromWeb(upstream.body).pipe(res);
}

async function serveFrontend(requestPath, req, res) {
  const routeToFile = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/style.css': 'style.css',
    '/app.js': 'app.js',
  };
  const fileName = routeToFile[requestPath] || 'index.html';
  const filePath = path.join(frontendDir, fileName);
  let cached = staticCache.get(filePath);
  const fileStat = await stat(filePath);
  if (!cached || cached.mtimeMs !== fileStat.mtimeMs) {
    const body = await readFile(filePath);
    cached = {
      body,
      mtimeMs: fileStat.mtimeMs,
      etag: `"${createHash('sha1').update(body).digest('hex')}"`,
    };
    staticCache.set(filePath, cached);
  }
  if (req.headers['if-none-match'] === cached.etag) {
    res.statusCode = 304;
    return res.end();
  }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  res.statusCode = 200;
  res.setHeader('Content-Type', types[path.extname(fileName)] || 'application/octet-stream');
  res.setHeader('Content-Length', cached.body.length);
  res.setHeader('ETag', cached.etag);
  res.setHeader('Cache-Control', process.env.NODE_ENV === 'production' && fileName !== 'index.html' ? 'public, max-age=3600' : 'no-cache');
  if (req.method === 'HEAD') return res.end();
  return res.end(cached.body);
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', body.length);
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  return res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

function shutdown(signal) {
  console.log(`${signal} received, closing server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
async function getVideo(id) {
  return invidiousJson(`/api/v1/videos/${id}`, {
    cacheKey: `video:${id}`,
    ttl: CACHE_TTL_MS,
  });
}

async function invidiousJson(route, { cacheKey = null, ttl = CACHE_TTL_MS } = {}) {
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) cache.delete(cacheKey);
  }

  const instances = orderedInstances();
  const errors = [];

  for (const instance of instances) {
    try {
      const response = await fetchWithTimeout(`${instance}${route}`, {
        headers: {
          accept: 'application/json',
          'user-agent': browserUserAgent(),
        },
      }, REQUEST_TIMEOUT_MS);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`${hostname(instance)} returned ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
      }

      const value = await response.json();
      preferredInstance = instance;
      instanceFailures.delete(instance);
      if (cacheKey) cache.set(cacheKey, { value, expiresAt: Date.now() + ttl });
      pruneCache();
      return value;
    } catch (error) {
      markFailure(instance);
      errors.push(error.message || String(error));
    }
  }

  throw new UpstreamError(`All configured Invidious instances failed. ${errors.join(' | ')}`);
}

async function proxyMedia(req, res, targetUrl, fallbackType) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new UpstreamError('The selected Invidious stream URL was invalid.');
  }
  if (!isSafeHttpUrl(parsed)) throw new UpstreamError('Refusing an unsafe media stream URL.');

  const headers = {
    'user-agent': browserUserAgent(),
    accept: '*/*',
  };
  if (req.headers.range) headers.range = req.headers.range;

  const upstream = await fetchWithTimeout(parsed, { headers, redirect: 'follow' }, 25_000);
  if (!upstream.ok && upstream.status !== 206) {
    throw new UpstreamError(`The media host returned ${upstream.status}.`);
  }

  res.statusCode = upstream.status;
  copyHeaders(upstream.headers, res, [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'etag', 'last-modified',
  ]);
  if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', fallbackType);
  res.setHeader('Cache-Control', 'private, max-age=0, no-store');

  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', (error) => {
    console.error('[media stream]', error);
    res.destroy(error);
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function chooseMuxedStream(streams, requestedItag) {
  const list = Array.isArray(streams) ? streams.filter((stream) => stream?.url) : [];
  if (requestedItag) {
    const exact = list.find((stream) => String(stream.itag) === requestedItag);
    if (exact) return exact;
  }

  return list
    .filter((stream) => String(stream.container || '').toLowerCase() === 'mp4' || String(stream.type || '').includes('mp4'))
    .sort((a, b) => streamScore(b) - streamScore(a))[0]
    || list.sort((a, b) => streamScore(b) - streamScore(a))[0]
    || null;
}

function streamScore(stream) {
  const label = String(stream.qualityLabel || stream.quality || '');
  const match = label.match(/(\d{3,4})p/);
  const resolution = match ? Number(match[1]) : 0;
  const fps = Number(stream.fps || 30);
  return Math.min(resolution, 1080) * 10 + Math.min(fps, 60);
}

function normalizeVideoList(items) {
  return (Array.isArray(items) ? items : []).map(normalizeVideoCard).filter(Boolean);
}

function normalizeSearchResults(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (item?.type === 'video' || item?.videoId) return normalizeVideoCard(item);
    if (item?.type === 'channel' || item?.authorId) {
      return {
        type: 'channel',
        id: item.authorId,
        title: item.author || 'Unknown channel',
        description: stripHtml(item.descriptionHtml || item.description || ''),
        subscribers: Number(item.subCount || 0),
        videos: Number(item.videoCount || 0),
        verified: Boolean(item.authorVerified),
        avatar: proxyImage(item.authorThumbnails?.at?.(-1)?.url || item.authorThumbnails?.[0]?.url),
      };
    }
    if (item?.type === 'playlist' || item?.playlistId) {
      return {
        type: 'playlist',
        id: item.playlistId,
        title: item.title || 'Untitled playlist',
        author: item.author || '',
        videoCount: Number(item.videoCount || 0),
        thumbnail: item.videos?.[0]?.videoId ? thumb(item.videos[0].videoId) : proxyImage(item.playlistThumbnail),
      };
    }
    return null;
  }).filter(Boolean);
}

function normalizeVideoCard(item) {
  const id = videoId(item?.videoId || item?.id);
  if (!id) return null;
  return {
    type: 'video',
    id,
    title: item.title || 'Untitled video',
    author: item.author || 'Unknown channel',
    authorId: item.authorId || '',
    verified: Boolean(item.authorVerified),
    views: Number(item.viewCount || 0),
    viewsText: item.viewCountText || '',
    published: Number(item.published || 0),
    publishedText: item.publishedText || '',
    lengthSeconds: Number(item.lengthSeconds || 0),
    live: Boolean(item.liveNow),
    premium: Boolean(item.premium),
    thumbnail: thumb(id),
    description: stripHtml(item.descriptionHtml || item.description || ''),
  };
}

function normalizeVideoDetails(item) {
  const id = videoId(item?.videoId);
  const streams = (Array.isArray(item?.formatStreams) ? item.formatStreams : [])
    .filter((stream) => stream?.url)
    .map((stream) => ({
      itag: String(stream.itag || ''),
      quality: stream.qualityLabel || stream.quality || 'auto',
      container: stream.container || '',
      type: stream.type || '',
      fps: Number(stream.fps || 0),
    }))
    .sort((a, b) => streamScore(b) - streamScore(a));

  return {
    id,
    title: item?.title || 'Untitled video',
    author: item?.author || 'Unknown channel',
    authorId: item?.authorId || '',
    authorVerified: Boolean(item?.authorVerified),
    authorSubscribers: Number(item?.subCountText?.replace?.(/[^\d]/g, '') || item?.authorSubscriberCount || 0),
    authorThumbnail: proxyImage(item?.authorThumbnails?.at?.(-1)?.url || item?.authorThumbnails?.[0]?.url),
    description: item?.description || stripHtml(item?.descriptionHtml || ''),
    views: Number(item?.viewCount || 0),
    likes: Number(item?.likeCount || 0),
    published: Number(item?.published || 0),
    publishedText: item?.publishedText || '',
    lengthSeconds: Number(item?.lengthSeconds || 0),
    live: Boolean(item?.liveNow),
    genre: item?.genre || '',
    allowedRegions: Array.isArray(item?.allowedRegions) ? item.allowedRegions : [],
    thumbnail: id ? thumb(id, 'hqdefault.jpg') : '',
    streams,
    recommended: normalizeVideoList(item?.recommendedVideos),
  };
}

function normalizeComments(data) {
  const comments = (Array.isArray(data?.comments) ? data.comments : []).map((comment) => ({
    id: String(comment.commentId || ''),
    author: comment.author || 'Anonymous',
    authorId: comment.authorId || '',
    authorThumbnail: proxyImage(comment.authorThumbnails?.at?.(-1)?.url || comment.authorThumbnails?.[0]?.url),
    verified: Boolean(comment.authorIsChannelOwner || comment.authorVerified),
    content: stripHtml(comment.contentHtml || comment.content || ''),
    published: Number(comment.published || 0),
    publishedText: comment.publishedText || '',
    likes: Number(comment.likeCount || 0),
    replies: Number(comment.replies?.replyCount || 0),
  }));
  return { comments, continuation: data?.continuation || '' };
}

function normalizeChannel(channel, videoResponse) {
  const videos = normalizeVideoList(videoResponse?.videos || videoResponse);
  return {
    id: channel?.authorId || '',
    author: channel?.author || 'Unknown channel',
    verified: Boolean(channel?.authorVerified),
    description: stripHtml(channel?.descriptionHtml || channel?.description || ''),
    subscribers: Number(channel?.subCount || 0),
    totalViews: Number(channel?.totalViews || 0),
    joined: Number(channel?.joined || 0),
    avatar: proxyImage(channel?.authorThumbnails?.at?.(-1)?.url || channel?.authorThumbnails?.[0]?.url),
    banner: proxyImage(channel?.authorBanners?.at?.(-1)?.url || channel?.authorBanners?.[0]?.url),
    videos,
  };
}

function normalizePlaylist(data) {
  return {
    id: data?.playlistId || '',
    title: data?.title || 'Untitled playlist',
    author: data?.author || '',
    authorId: data?.authorId || '',
    description: stripHtml(data?.descriptionHtml || data?.description || ''),
    videoCount: Number(data?.videoCount || 0),
    totalLength: Number(data?.totalLength || 0),
    videos: normalizeVideoList(data?.videos),
  };
}

function thumb(id, file = 'hqdefault.jpg') {
  return `/api/thumb/${encodeURIComponent(id)}/${file}`;
}

function proxyImage(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, preferredInstance);
    const match = parsed.pathname.match(/\/vi\/([\w-]{11})\/([^/?]+)/);
    if (match) return thumb(match[1], match[2]);
    if (!isAllowedImageHost(parsed.hostname)) return '';
    return `/api/image?url=${encodeURIComponent(parsed.toString())}`;
  } catch {
    return '';
  }
}

function safeImageUrl(value) {
  try {
    const parsed = new URL(value, preferredInstance);
    if (!isSafeHttpUrl(parsed) || !isAllowedImageHost(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isAllowedImageHost(host) {
  const normalized = String(host || '').toLowerCase();
  const instanceHosts = configuredInstances.map(hostname);
  return instanceHosts.includes(normalized)
    || normalized === 'i.ytimg.com'
    || normalized.endsWith('.ytimg.com')
    || normalized === 'yt3.ggpht.com'
    || normalized.endsWith('.ggpht.com')
    || normalized.endsWith('.googleusercontent.com');
}

function orderedInstances() {
  const now = Date.now();
  const rest = configuredInstances.filter((instance) => instance !== preferredInstance);
  return [preferredInstance, ...rest].sort((a, b) => {
    const aBlocked = (instanceFailures.get(a)?.retryAt || 0) > now ? 1 : 0;
    const bBlocked = (instanceFailures.get(b)?.retryAt || 0) > now ? 1 : 0;
    return aBlocked - bBlocked;
  });
}

function markFailure(instance) {
  const previous = instanceFailures.get(instance) || { count: 0 };
  const count = previous.count + 1;
  const delay = Math.min(60_000 * (2 ** Math.min(count - 1, 4)), 15 * 60_000);
  instanceFailures.set(instance, { count, retryAt: Date.now() + delay });
}

function pruneCache() {
  if (cache.size < 500) return;
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > 400) cache.delete(cache.keys().next().value);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Upstream request timed out.')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Upstream request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function copyHeaders(headers, res, names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

function normalizeInstance(value) {
  try {
    const url = new URL(String(value).trim());
    if (!isSafeHttpUrl(url)) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}


function isSafeHttpUrl(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

function isLoopbackHost(host) {
  const value = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function hostname(value) {
  try { return new URL(value).hostname; } catch { return String(value); }
}

function cleanText(value, max = 200) {
  return String(value || '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}

function allowed(value, values, fallback) {
  const candidate = cleanText(value, 40).toLowerCase();
  return values.includes(candidate) ? candidate : fallback;
}

function safeRegion(value) {
  const candidate = cleanText(value, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(candidate) ? candidate : '';
}

function videoId(value) {
  const candidate = cleanText(value, 20);
  return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : '';
}

function channelId(value) {
  const candidate = cleanText(value, 64);
  return /^(UC[\w-]{20,30}|[\w-]{3,64})$/.test(candidate) ? candidate : '';
}

function playlistId(value) {
  const candidate = cleanText(value, 100);
  return /^[A-Za-z0-9_-]{10,100}$/.test(candidate) ? candidate : '';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .trim();
}

function unique(items) {
  return [...new Set(items)];
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function browserUserAgent() {
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 OnyxTerminal/2.0';
}


class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
    this.code = 'INVIDIOUS_UPSTREAM_ERROR';
  }
}

export {
  server,
  chooseMuxedStream,
  normalizeVideoCard,
  normalizeSearchResults,
  stripHtml,
};
