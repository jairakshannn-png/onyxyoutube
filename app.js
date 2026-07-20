const app = document.getElementById('app');
const cardTpl = document.getElementById('tpl-card');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = hash.split('?');
  const params = new URLSearchParams(queryPart || '');

  if (pathPart === '/' ) return renderHome();
  if (pathPart === '/search') return renderSearch(params.get('q') || '');
  if (pathPart === '/watch') return renderWatch(params.get('v') || '');
  renderState('unknown route');
}

function renderState(message, isError = false) {
  app.innerHTML = `<div class="state ${isError ? 'error' : ''}"><span class="prompt">${isError ? '!' : '$'}</span>${escapeHtml(message)}</div>`;
}

async function getJSON(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function formatCount(n) {
  if (n === null || n === undefined) return null;
  if (typeof n === 'string') return n;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function buildCard(video, targetRoot = 'card') {
  const node = cardTpl.content.firstElementChild.cloneNode(true);
  node.className = targetRoot === 'card' ? 'card' : 'related-card';
  node.href = `#/watch?v=${video.id}`;

  const img = node.querySelector('img');
  img.src = video.thumbnail;
  img.alt = video.title || '';

  const durationEl = node.querySelector('.duration');
  if (video.duration) {
    durationEl.textContent = video.duration;
  } else {
    durationEl.remove();
  }

  node.querySelector('.title').textContent = video.title || 'Untitled';
  node.querySelector('.channel').textContent = video.author || '';

  const statsParts = [formatCount(video.views), video.published].filter(Boolean);
  node.querySelector('.stats').textContent = statsParts.join(' · ');

  return node;
}

async function renderHome() {
  renderState('loading home feed...');
  try {
    const { videos } = await getJSON('/api/home');
    if (!videos.length) return renderState('no videos returned — try search instead');
    app.innerHTML = `<p class="section-label">// trending</p><div class="grid" id="grid"></div>`;
    const grid = document.getElementById('grid');
    videos.forEach((v) => grid.appendChild(buildCard(v)));
  } catch (err) {
    renderState(err.message, true);
  }
}

async function renderSearch(q) {
  searchInput.value = q;
  if (!q) return renderState('type something to search');
  renderState(`searching "${q}"...`);
  try {
    const { videos } = await getJSON(`/api/search?q=${encodeURIComponent(q)}`);
    if (!videos.length) return renderState(`no results for "${q}"`);
    app.innerHTML = `<p class="section-label">// results for "${escapeHtml(q)}"</p><div class="grid" id="grid"></div>`;
    const grid = document.getElementById('grid');
    videos.forEach((v) => grid.appendChild(buildCard(v)));
  } catch (err) {
    renderState(err.message, true);
  }
}

async function renderWatch(id) {
  if (!id) return renderState('missing video id', true);
  renderState('loading video...');
  try {
    const video = await getJSON(`/api/video/${encodeURIComponent(id)}`);

    app.innerHTML = `
      <div class="watch-layout">
        <div>
          <div class="player-wrap">
            <video controls autoplay preload="metadata" poster="${video.thumbnail}">
              <source src="/api/stream/${encodeURIComponent(id)}" type="video/mp4" />
            </video>
          </div>
          <h1 class="watch-title">${escapeHtml(video.title || 'Untitled')}</h1>
          <div class="watch-subrow">
            <span class="channel-name">${escapeHtml(video.author || 'Unknown channel')}</span>
            <span>${[formatCount(video.views) ? formatCount(video.views) + ' views' : null, video.published].filter(Boolean).join(' · ')}</span>
          </div>
          <div class="description" id="desc">${escapeHtml(video.description || 'No description.')}</div>
          <button class="description-toggle" id="desc-toggle">show more</button>
        </div>
        <div>
          <p class="section-label">// up next</p>
          <div class="related-list" id="related"></div>
        </div>
      </div>
    `;

    const descEl = document.getElementById('desc');
    document.getElementById('desc-toggle').addEventListener('click', () => {
      const expanded = descEl.classList.toggle('expanded');
      document.getElementById('desc-toggle').textContent = expanded ? 'show less' : 'show more';
    });

    const relatedRoot = document.getElementById('related');
    (video.related || []).forEach((v) => relatedRoot.appendChild(buildCard(v, 'related')));
  } catch (err) {
    renderState(err.message, true);
  }
}
