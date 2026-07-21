// Quick, dependency-free unit test for the pure-logic helpers in server.js.
// Run with: node test-helpers.mjs
// This does NOT hit the network — it feeds fixture data through the exact
// same regex/parsing logic to catch bugs before a real deploy.

function resolveDdgUrl(href) {
  try {
    const full = href.startsWith('//') ? `https:${href}` : href;
    const parsed = new URL(full);
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : full;
  } catch {
    return href;
  }
}

function extractVideoId(url) {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function describeError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const looksLikeBotCheck =
    msg.includes('bot') ||
    msg.includes('sign in') ||
    msg.includes('confirm') ||
    msg.includes('login_required') ||
    msg.includes('po_token') ||
    msg.includes('potoken');
  return looksLikeBotCheck ? 'bot-check' : 'generic';
}

function parseDdgHtml(html) {
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const seen = new Set();
  const videos = [];
  let match;
  while ((match = linkPattern.exec(html)) !== null) {
    const realUrl = resolveDdgUrl(match[1]);
    const id = extractVideoId(realUrl);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    videos.push({ id, title: decodeEntities(match[2].replace(/<[^>]+>/g, '').trim()) });
  }
  return videos;
}

// --- Fixtures ---------------------------------------------------------

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    console.log('   expected:', expected);
    console.log('   actual:  ', actual);
  }
}

// 1. Plain youtube.com/watch URL
check(
  'extractVideoId — youtube.com/watch',
  extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'),
  'dQw4w9WgXcQ'
);

// 2. youtu.be short URL
check('extractVideoId — youtu.be', extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');

// 3. Non-YouTube URL should return null
check('extractVideoId — non-YouTube URL', extractVideoId('https://example.com/foo'), null);

// 4. DDG redirect-wrapped URL
check(
  'resolveDdgUrl — unwraps uddg redirect',
  resolveDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&rut=abc123'),
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
);

// 5. HTML entity decoding
check('decodeEntities', decodeEntities('Rick &amp; Morty &#x27;Pilot&#x27;'), "Rick & Morty 'Pilot'");

// 6. Bot-check message classification
check(
  'describeError — recognizes bot-check message',
  describeError(new Error("Sign in to confirm you're not a bot")),
  'bot-check'
);

// 7. Ordinary error should NOT be misclassified as a bot-check
check('describeError — ordinary error stays generic', describeError(new Error('Video unavailable in your region')), 'generic');

// 8. Full DDG HTML fixture (2 results, 1 duplicate, 1 non-YouTube link mixed in,
//    title with a highlighted <b> tag like DDG actually renders)
const fakeDdgHtml = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&rut=1">
      Rick Astley - <b>Never Gonna Give You Up</b>
    </a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnot-youtube&rut=2">
      Unrelated result
    </a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ&rut=3">
      Duplicate of the first video (different URL shape)
    </a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DoHg5SJYRHA0&rut=4">
      Second real &amp; distinct video
    </a>
  </div>
`;

check('parseDdgHtml — extracts videos, dedupes, ignores non-YouTube', parseDdgHtml(fakeDdgHtml), [
  { id: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up' },
  { id: 'oHg5SJYRHA0', title: 'Second real & distinct video' },
]);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
