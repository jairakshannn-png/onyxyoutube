import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const VIDEO_ID = 'dQw4w9WgXcQ';
const CHANNEL_ID = 'UC1234567890123456789012';
const PLAYLIST_ID = 'PL12345678901234567890';

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function videoCard() {
  return {
    type: 'video',
    videoId: VIDEO_ID,
    title: 'Mock terminal video',
    author: 'Mock Channel',
    authorId: CHANNEL_ID,
    viewCount: 12345,
    published: Math.floor(Date.now() / 1000) - 3600,
    publishedText: '1 hour ago',
    lengthSeconds: 213,
  };
}

test('serves the frontend and proxies a mock Invidious API', async (t) => {
  const mock = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/v1/trending' || url.pathname === '/api/v1/popular') return json(res, [videoCard()]);
    if (url.pathname === '/api/v1/search') return json(res, [videoCard()]);
    if (url.pathname === '/api/v1/search/suggestions') return json(res, { suggestions: ['mock one', 'mock two'] });
    if (url.pathname === `/api/v1/videos/${VIDEO_ID}`) {
      return json(res, {
        ...videoCard(),
        description: 'Mock description',
        formatStreams: [{ itag: '18', qualityLabel: '360p', container: 'mp4', type: 'video/mp4', url: `http://127.0.0.1:${mock.address().port}/media.mp4` }],
        recommendedVideos: [videoCard()],
      });
    }
    if (url.pathname === `/api/v1/comments/${VIDEO_ID}`) return json(res, { comments: [{ commentId: '1', author: 'Tester', content: 'Works', likeCount: 2 }] });
    if (url.pathname === `/api/v1/channels/${CHANNEL_ID}`) return json(res, { authorId: CHANNEL_ID, author: 'Mock Channel', subCount: 10 });
    if (url.pathname === `/api/v1/channels/${CHANNEL_ID}/videos`) return json(res, { videos: [videoCard()] });
    if (url.pathname === `/api/v1/playlists/${PLAYLIST_ID}`) return json(res, { playlistId: PLAYLIST_ID, title: 'Mock list', videos: [videoCard()] });
    if (url.pathname === '/media.mp4') {
      const bytes = Buffer.from('mock-video-bytes');
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length, 'accept-ranges': 'bytes' });
      return res.end(bytes);
    }
    json(res, { error: 'not found' }, 404);
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');

  process.env.INVIDIOUS_INSTANCE = `http://127.0.0.1:${mock.address().port}`;
  process.env.INVIDIOUS_FALLBACKS = '';
  process.env.MEDIA_PROXY = 'true';

  const module = await import(`./server.js?integration=${Date.now()}`);
  const appServer = module.server;
  appServer.listen(0, '127.0.0.1');
  await once(appServer, 'listening');
  const base = `http://127.0.0.1:${appServer.address().port}`;

  t.after(() => {
    appServer.close();
    mock.close();
  });

  const health = await fetch(`${base}/healthz`).then((response) => response.json());
  assert.equal(health.ok, true);

  const htmlResponse = await fetch(`${base}/`);
  assert.equal(htmlResponse.status, 200);
  assert.match(await htmlResponse.text(), /ONYX Terminal/);

  const home = await fetch(`${base}/api/home`).then((response) => response.json());
  assert.equal(home.trending[0].id, VIDEO_ID);
  assert.equal(home.popular[0].title, 'Mock terminal video');

  const search = await fetch(`${base}/api/search?q=mock`).then((response) => response.json());
  assert.equal(search.results[0].author, 'Mock Channel');

  const details = await fetch(`${base}/api/video/${VIDEO_ID}`).then((response) => response.json());
  assert.equal(details.streams[0].quality, '360p');

  const mediaResponse = await fetch(`${base}/api/media/${VIDEO_ID}?itag=18`);
  assert.equal(mediaResponse.status, 200);
  assert.equal(await mediaResponse.text(), 'mock-video-bytes');
});
