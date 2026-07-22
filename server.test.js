import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMuxedStream, normalizeVideoCard, normalizeSearchResults, stripHtml } from './server.js';

test('chooseMuxedStream prefers requested itag', () => {
  const streams = [
    { itag: '18', qualityLabel: '360p', container: 'mp4', url: 'https://example.com/360' },
    { itag: '22', qualityLabel: '720p', container: 'mp4', url: 'https://example.com/720' },
  ];
  assert.equal(chooseMuxedStream(streams, '18').itag, '18');
});

test('chooseMuxedStream chooses highest compatible stream', () => {
  const streams = [
    { itag: '18', qualityLabel: '360p', container: 'mp4', url: 'https://example.com/360' },
    { itag: '22', qualityLabel: '720p', container: 'mp4', url: 'https://example.com/720' },
  ];
  assert.equal(chooseMuxedStream(streams).itag, '22');
});

test('normalizes video cards', () => {
  const card = normalizeVideoCard({ videoId: 'dQw4w9WgXcQ', title: 'Test', author: 'Channel', viewCount: 12 });
  assert.equal(card.id, 'dQw4w9WgXcQ');
  assert.equal(card.title, 'Test');
  assert.equal(card.views, 12);
});

test('normalizes mixed search results', () => {
  const results = normalizeSearchResults([
    { type: 'video', videoId: 'dQw4w9WgXcQ', title: 'Video' },
    { type: 'playlist', playlistId: 'PL1234567890', title: 'List' },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[1].type, 'playlist');
});

test('stripHtml decodes common entities', () => {
  assert.equal(stripHtml('<b>Hello</b><br>Tom &amp; Jerry'), 'Hello\nTom & Jerry');
});
