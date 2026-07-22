const app = document.querySelector('#app');
const searchForm = document.querySelector('#search-form');
const searchInput = document.querySelector('#search-input');
const suggestionsBox = document.querySelector('#suggestions');
const sidebar = document.querySelector('#sidebar');
const menuButton = document.querySelector('#menu-button');
const helpDialog = document.querySelector('#help-dialog');
const statusLight = document.querySelector('#status-light');
const instanceStatus = document.querySelector('#instance-status');
const cardTemplate = document.querySelector('#video-card-template');

const state = {
  home: null,
  suggestions: [],
  suggestionIndex: -1,
  shortcutPrefix: '',
  requestController: null,
};

const storage = {
  favorites: 'onyx:favorites:v2',
  history: 'onyx:history:v2',
  subscriptions: 'onyx:subscriptions:v2',
};

boot();

async function boot() {
  bindEvents();
  tickClock();
  setInterval(tickClock, 1000);
  await loadConfig();
  route();
}

function bindEvents() {
  window.addEventListener('hashchange', route);
  menuButton.addEventListener('click', () => sidebar.classList.toggle('open'));
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('a')) sidebar.classList.remove('open');
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runCommand(searchInput.value);
  });

  searchInput.addEventListener('input', debounce(async () => {
    const value = searchInput.value.trim();
    if (!value || value.startsWith(':') || value.length < 2) return hideSuggestions();
    try {
      const data = await api(`/api/suggestions?q=${encodeURIComponent(value)}`, { silent: true });
      state.suggestions = data.suggestions || [];
      state.suggestionIndex = -1;
      renderSuggestions();
    } catch {
      hideSuggestions();
    }
  }, 220));

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && state.suggestions.length) {
      event.preventDefault();
      state.suggestionIndex = Math.min(state.suggestionIndex + 1, state.suggestions.length - 1);
      renderSuggestions();
    } else if (event.key === 'ArrowUp' && state.suggestions.length) {
      event.preventDefault();
      state.suggestionIndex = Math.max(state.suggestionIndex - 1, 0);
      renderSuggestions();
    } else if (event.key === 'Enter' && state.suggestionIndex >= 0) {
      event.preventDefault();
      runCommand(state.suggestions[state.suggestionIndex]);
    } else if (event.key === 'Escape') {
      hideSuggestions();
      searchInput.blur();
    }
  });

  suggestionsBox.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (button) runCommand(button.dataset.value);
  });

  document.addEventListener('click', (event) => {
    if (!searchForm.contains(event.target)) hideSuggestions();
  });

  document.addEventListener('keydown', handleGlobalKeys);
  document.querySelector('#close-help').addEventListener('click', () => helpDialog.close());
}

function handleGlobalKeys(event) {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (event.key === '?' && !typing) {
    event.preventDefault();
    helpDialog.showModal();
    return;
  }
  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (event.key === 'Escape') {
    hideSuggestions();
    sidebar.classList.remove('open');
    if (helpDialog.open) helpDialog.close();
  }
  if (typing) return;
  if (state.shortcutPrefix === 'g') {
    const routes = { h: '#/', t: '#/trending', p: '#/popular', f: '#/favorites', r: '#/history' };
    if (routes[event.key.toLowerCase()]) location.hash = routes[event.key.toLowerCase()];
    state.shortcutPrefix = '';
  } else if (event.key.toLowerCase() === 'g') {
    state.shortcutPrefix = 'g';
    setTimeout(() => { state.shortcutPrefix = ''; }, 900);
  }
}

async function route() {
  if (state.requestController) state.requestController.abort();
  state.requestController = new AbortController();
  hideSuggestions();
  window.scrollTo({ top: 0, behavior: 'instant' });
  updateActiveNav();

  const { routeName, params } = parseHash();
  try {
    if (routeName === 'home') return renderHome();
    if (routeName === 'trending') return renderFeed('trending');
    if (routeName === 'popular') return renderFeed('popular');
    if (routeName === 'search') return renderSearch(params);
    if (routeName === 'watch') return renderWatch(params.get('v'));
    if (routeName === 'channel') return renderChannel(params.get('id'));
    if (routeName === 'playlist') return renderPlaylist(params.get('id'));
    if (routeName === 'favorites') return renderLibrary('favorites');
    if (routeName === 'history') return renderLibrary('history');
    renderNotFound();
  } catch (error) {
    if (error.name !== 'AbortError') renderError(error);
  }
}

function parseHash() {
  const raw = location.hash.slice(1) || '/';
  const [pathname, query = ''] = raw.split('?');
  const routeName = pathname === '/' ? 'home' : pathname.replace(/^\//, '').split('/')[0];
  return { routeName, params: new URLSearchParams(query) };
}

async function renderHome() {
  showLoading('initialising feed');
  const data = await getHome();
  app.innerHTML = `
    ${pageHead('home', 'public feed via Invidious', `<button class="terminal-button" data-refresh>refresh --no-cache</button>`)}
    <section class="section">
      <h2 class="section-title">trending now <span class="count">${data.trending.length} entries</span></h2>
      <div class="video-grid" id="trending-grid"></div>
    </section>
    <section class="section">
      <h2 class="section-title">popular <span class="count">${data.popular.length} entries</span></h2>
      <div class="video-grid" id="popular-grid"></div>
    </section>`;
  renderCards(document.querySelector('#trending-grid'), data.trending.slice(0, 12));
  renderCards(document.querySelector('#popular-grid'), data.popular.slice(0, 12));
  document.querySelector('[data-refresh]').addEventListener('click', async () => {
    state.home = null;
    await renderHome();
  });
}

async function renderFeed(kind) {
  showLoading(`loading ${kind}`);
  const data = await getHome();
  const videos = data[kind] || [];
  app.innerHTML = `${pageHead(kind, `${videos.length} results from the active instance`)}<div class="video-grid" id="feed-grid"></div>`;
  renderCards(document.querySelector('#feed-grid'), videos);
}

async function renderSearch(params) {
  const query = params.get('q') || '';
  if (!query) {
    app.innerHTML = `${pageHead('search', 'awaiting query')}${emptyState('No query supplied', 'Press / and enter something to search.')}`;
    return;
  }

  searchInput.value = query;
  showLoading(`searching: ${query}`);
  const page = Number(params.get('page') || 1);
  const type = params.get('type') || 'video';
  const sort = params.get('sort') || 'relevance';
  const duration = params.get('duration') || '';
  const date = params.get('date') || '';
  const apiParams = new URLSearchParams({ q: query, page, type, sort });
  if (duration) apiParams.set('duration', duration);
  if (date) apiParams.set('date', date);
  const data = await api(`/api/search?${apiParams}`);

  app.innerHTML = `
    ${pageHead(`search/${query}`, `${data.results.length} records · page ${page}`)}
    <div class="search-filters">
      ${selectFilter('type', ['video', 'all', 'channel', 'playlist'], type)}
      ${selectFilter('sort', ['relevance', 'views'], sort)}
      ${selectFilter('duration', ['', 'short', 'medium', 'long'], duration, 'any duration')}
      ${selectFilter('date', ['', 'hour', 'today', 'week', 'month', 'year'], date, 'any date')}
    </div>
    <div class="search-list" id="search-results"></div>
    <div class="page-actions pagination-actions">
      <button class="terminal-button" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? 'disabled' : ''}>← previous</button>
      <button class="terminal-button" data-page="${page + 1}">next →</button>
    </div>`;

  const results = document.querySelector('#search-results');
  if (!data.results.length) {
    results.innerHTML = emptyState('No matching records', 'Try a broader query or remove filters.');
  } else {
    const videos = data.results.filter((item) => item.type === 'video');
    if (videos.length) {
      const grid = document.createElement('div');
      grid.className = 'video-grid';
      renderCards(grid, videos);
      results.append(grid);
    }
    data.results.filter((item) => item.type !== 'video').forEach((item) => {
      if (item.type === 'channel') results.insertAdjacentHTML('beforeend', channelSearchItem(item));
      if (item.type === 'playlist') results.insertAdjacentHTML('beforeend', playlistSearchItem(item));
    });
  }

  app.querySelectorAll('select[data-filter]').forEach((select) => select.addEventListener('change', () => {
    const next = new URLSearchParams(params);
    if (select.value) next.set(select.dataset.filter, select.value);
    else next.delete(select.dataset.filter);
    next.set('page', '1');
    location.hash = `#/search?${next}`;
  }));
  app.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
    const next = new URLSearchParams(params);
    next.set('page', button.dataset.page);
    location.hash = `#/search?${next}`;
  }));
}

async function renderWatch(id) {
  if (!validVideoId(id)) return renderNotFound('Invalid video ID');
  showLoading('requesting video metadata');
  const video = await api(`/api/video/${encodeURIComponent(id)}`);
  addHistory(video);

  const qualities = video.streams?.length
    ? video.streams.map((stream) => `<option value="${escapeAttr(stream.itag)}">${escapeHtml(stream.quality)} · ${escapeHtml(stream.container || 'stream')}</option>`).join('')
    : '<option value="">auto</option>';

  app.innerHTML = `
    <div class="watch-layout">
      <section>
        <div class="player-shell">
          <video id="player" controls playsinline preload="metadata" poster="${escapeAttr(video.thumbnail)}">
            <source src="/api/media/${video.id}${video.streams?.[0]?.itag ? `?itag=${encodeURIComponent(video.streams[0].itag)}` : ''}" type="video/mp4">
          </video>
          <div class="player-overlay" id="player-overlay" hidden></div>
        </div>
        <h1 class="watch-title">${escapeHtml(video.title)}</h1>
        <div class="watch-meta">
          <span>${formatNumber(video.views)} views</span>
          <span>${escapeHtml(video.publishedText || relativeDate(video.published))}</span>
          <span>${formatDuration(video.lengthSeconds)}</span>
          ${video.genre ? `<span>${escapeHtml(video.genre)}</span>` : ''}
        </div>
        <div class="watch-actions">
          <button class="terminal-button ${isFavorite(video.id) ? 'active' : ''}" data-favorite>${isFavorite(video.id) ? 'saved ✓' : 'save +fav'}</button>
          <button class="terminal-button" data-copy>copy link</button>
          <label class="filter-select">quality <select id="quality-select">${qualities}</select></label>
        </div>
        <div class="channel-strip">
          ${video.authorThumbnail ? `<img src="${escapeAttr(video.authorThumbnail)}" alt="">` : '<div class="channel-avatar"></div>'}
          <div class="channel-copy">
            <a href="#/channel?id=${encodeURIComponent(video.authorId)}"><strong>${escapeHtml(video.author)}${video.authorVerified ? ' ✓' : ''}</strong></a>
            <span>${video.authorSubscribers ? `${formatNumber(video.authorSubscribers)} subscribers` : 'channel'}</span>
          </div>
          <button class="terminal-button ${isSubscribed(video.authorId) ? 'active' : ''}" data-subscribe>${isSubscribed(video.authorId) ? 'subscribed' : 'subscribe.local'}</button>
        </div>
        <pre class="description">${escapeHtml(video.description || 'No description supplied.')}</pre>
        <section class="comments">
          <h2 class="section-title">comments</h2>
          <div id="comments-zone"><button class="terminal-button" data-load-comments>load comments</button></div>
        </section>
      </section>
      <aside>
        <h2 class="section-title">next queue <span class="count">${video.recommended.length}</span></h2>
        <div class="related-list" id="related-list"></div>
      </aside>
    </div>`;

  renderRelated(document.querySelector('#related-list'), video.recommended.slice(0, 20));
  const player = document.querySelector('#player');
  const overlay = document.querySelector('#player-overlay');
  player.addEventListener('error', () => {
    overlay.hidden = false;
    overlay.innerHTML = 'Playback failed on the active Invidious instance.<br>Try another quality, refresh, or change the instance environment variable on Render.';
  });

  document.querySelector('[data-favorite]').addEventListener('click', (event) => {
    toggleFavorite(video);
    event.currentTarget.classList.toggle('active', isFavorite(video.id));
    event.currentTarget.textContent = isFavorite(video.id) ? 'saved ✓' : 'save +fav';
  });
  document.querySelector('[data-subscribe]').addEventListener('click', (event) => {
    toggleSubscription({ id: video.authorId, name: video.author });
    event.currentTarget.classList.toggle('active', isSubscribed(video.authorId));
    event.currentTarget.textContent = isSubscribed(video.authorId) ? 'subscribed' : 'subscribe.local';
  });
  document.querySelector('[data-copy]').addEventListener('click', async () => {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied to clipboard.');
  });
  document.querySelector('#quality-select').addEventListener('change', (event) => {
    const time = player.currentTime || 0;
    player.src = `/api/media/${video.id}?itag=${encodeURIComponent(event.target.value)}`;
    player.currentTime = time;
    player.play().catch(() => {});
  });
  document.querySelector('[data-load-comments]').addEventListener('click', () => loadComments(video.id));
}

async function loadComments(id) {
  const zone = document.querySelector('#comments-zone');
  zone.innerHTML = '<p class="notice">fetching comment tree...</p>';
  try {
    const data = await api(`/api/comments/${id}`);
    zone.innerHTML = data.comments.length
      ? data.comments.map(commentMarkup).join('')
      : emptyState('No comments returned', 'The active instance may have comments disabled.');
  } catch (error) {
    zone.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
  }
}

async function renderChannel(id) {
  if (!id) return renderNotFound('Channel ID missing');
  showLoading('loading channel record');
  const channel = await api(`/api/channel/${encodeURIComponent(id)}`);
  app.innerHTML = `
    <section class="channel-hero">
      <div class="channel-banner">${channel.banner ? `<img src="${escapeAttr(channel.banner)}" alt="">` : ''}</div>
      <div class="channel-info">
        ${channel.avatar ? `<img class="channel-avatar" src="${escapeAttr(channel.avatar)}" alt="">` : '<div class="channel-avatar"></div>'}
        <div>
          <h1>${escapeHtml(channel.author)}${channel.verified ? ' ✓' : ''}</h1>
          <p>${formatNumber(channel.subscribers)} subscribers · ${formatNumber(channel.totalViews)} total views</p>
        </div>
        <button class="terminal-button ${isSubscribed(channel.id) ? 'active' : ''}" data-subscribe>${isSubscribed(channel.id) ? 'subscribed' : 'subscribe.local'}</button>
      </div>
    </section>
    <section class="section">
      <h2 class="section-title">latest uploads <span class="count">${channel.videos.length}</span></h2>
      <div class="video-grid" id="channel-videos"></div>
    </section>
    ${channel.description ? `<pre class="description">${escapeHtml(channel.description)}</pre>` : ''}`;
  renderCards(document.querySelector('#channel-videos'), channel.videos);
  document.querySelector('[data-subscribe]').addEventListener('click', (event) => {
    toggleSubscription({ id: channel.id, name: channel.author });
    event.currentTarget.classList.toggle('active', isSubscribed(channel.id));
    event.currentTarget.textContent = isSubscribed(channel.id) ? 'subscribed' : 'subscribe.local';
  });
}

async function renderPlaylist(id) {
  if (!id) return renderNotFound('Playlist ID missing');
  showLoading('loading playlist');
  const playlist = await api(`/api/playlist/${encodeURIComponent(id)}`);
  app.innerHTML = `
    ${pageHead(playlist.title, `${playlist.videoCount} videos · ${formatDuration(playlist.totalLength)}`)}
    ${playlist.description ? `<pre class="description playlist-description">${escapeHtml(playlist.description)}</pre>` : ''}
    <div class="video-grid" id="playlist-videos"></div>`;
  renderCards(document.querySelector('#playlist-videos'), playlist.videos);
}

function renderLibrary(kind) {
  const items = readStore(storage[kind]);
  const title = kind === 'favorites' ? 'favourites' : 'history';
  app.innerHTML = `
    ${pageHead(title, `${items.length} local records`, `<button class="terminal-button danger" data-clear>clear ${title}</button>`)}
    <div id="library-zone"></div>`;
  const zone = document.querySelector('#library-zone');
  if (!items.length) zone.innerHTML = emptyState(`No ${title} yet`, kind === 'favorites' ? 'Save videos with the + button.' : 'Videos you open appear here, stored only in this browser.');
  else {
    zone.className = 'video-grid';
    renderCards(zone, items);
  }
  document.querySelector('[data-clear]').addEventListener('click', () => {
    localStorage.removeItem(storage[kind]);
    renderLibrary(kind);
    toast(`${title} cleared.`);
  });
}

function renderCards(container, videos, offset = 0) {
  videos.forEach((video, index) => {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    const watchUrl = `#/watch?v=${encodeURIComponent(video.id)}`;
    const title = node.querySelector('.video-title');
    const thumbnail = node.querySelector('img');
    const thumbLink = node.querySelector('.thumbnail-link');
    const author = node.querySelector('.video-author');
    const save = node.querySelector('.save-button');

    thumbLink.href = watchUrl;
    title.href = watchUrl;
    title.textContent = video.title;
    thumbnail.src = video.thumbnail || `/api/thumb/${video.id}/hqdefault.jpg`;
    thumbnail.alt = `${video.title} thumbnail`;
    author.textContent = `${video.author || 'Unknown channel'}${video.verified ? ' ✓' : ''}`;
    author.href = video.authorId ? `#/channel?id=${encodeURIComponent(video.authorId)}` : watchUrl;
    node.querySelector('.video-stats').textContent = [
      video.viewsText || (video.views ? `${formatNumber(video.views)} views` : ''),
      video.publishedText || relativeDate(video.published),
    ].filter(Boolean).join(' · ');
    node.querySelector('.duration').textContent = video.live ? '' : formatDuration(video.lengthSeconds);
    node.querySelector('.live-badge').hidden = !video.live;
    node.querySelector('.card-index').textContent = String(offset + index + 1).padStart(2, '0');
    save.classList.toggle('saved', isFavorite(video.id));
    save.textContent = isFavorite(video.id) ? '✓' : '+';
    save.addEventListener('click', () => {
      toggleFavorite(video);
      save.classList.toggle('saved', isFavorite(video.id));
      save.textContent = isFavorite(video.id) ? '✓' : '+';
    });
    container.append(node);
  });
}

function renderRelated(container, videos) {
  container.innerHTML = videos.map((video) => `
    <a class="related-item" href="#/watch?v=${encodeURIComponent(video.id)}">
      <img src="${escapeAttr(video.thumbnail)}" alt="" loading="lazy">
      <div>
        <strong>${escapeHtml(video.title)}</strong>
        <span>${escapeHtml(video.author)} · ${video.views ? `${formatNumber(video.views)} views` : ''}</span>
      </div>
    </a>`).join('');
}

function commentMarkup(comment) {
  return `<article class="comment">
    ${comment.authorThumbnail ? `<img src="${escapeAttr(comment.authorThumbnail)}" alt="">` : '<div></div>'}
    <div>
      <div class="comment-head"><strong>${escapeHtml(comment.author)}${comment.verified ? ' ✓' : ''}</strong><span>${escapeHtml(comment.publishedText || relativeDate(comment.published))}</span></div>
      <div class="comment-body">${escapeHtml(comment.content)}</div>
      <div class="comment-foot">+${formatNumber(comment.likes)} · ${comment.replies} replies</div>
    </div>
  </article>`;
}

function runCommand(raw) {
  const value = raw.trim();
  if (!value) return;
  hideSuggestions();
  searchInput.blur();

  const directId = extractVideoId(value);
  if (directId) {
    location.hash = `#/watch?v=${directId}`;
    return;
  }

  const command = value.toLowerCase();
  const routes = {
    ':home': '#/', ':trending': '#/trending', ':popular': '#/popular',
    ':history': '#/history', ':favorites': '#/favorites', ':favourites': '#/favorites',
  };
  if (routes[command]) {
    location.hash = routes[command];
    searchInput.value = '';
    return;
  }
  if (command === ':help') {
    helpDialog.showModal();
    searchInput.value = '';
    return;
  }
  if (command === ':clear history') {
    localStorage.removeItem(storage.history);
    toast('History cleared.');
    location.hash = '#/history';
    return;
  }
  if (command === ':clear favorites' || command === ':clear favourites') {
    localStorage.removeItem(storage.favorites);
    toast('Favourites cleared.');
    location.hash = '#/favorites';
    return;
  }
  location.hash = `#/search?q=${encodeURIComponent(value)}&type=video&sort=relevance&page=1`;
}

async function getHome() {
  if (!state.home) state.home = await api('/api/home');
  return state.home;
}

async function loadConfig() {
  try {
    const config = await api('/api/config', { silent: true });
    instanceStatus.textContent = config.activeInstance;
    statusLight.className = 'status-light online';
  } catch {
    instanceStatus.textContent = 'backend offline';
    statusLight.className = 'status-light offline';
  }
}

async function api(url, { silent = false } = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: state.requestController?.signal,
  });
  let body = null;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || `Request failed with ${response.status}`);
    if (!silent) toast(error.message, 'error');
    throw error;
  }
  return body;
}

function showLoading(label) {
  app.innerHTML = `${pageHead('working', label)}<div class="loading-grid">${'<div class="skeleton"></div>'.repeat(8)}</div>`;
}

function renderError(error) {
  app.innerHTML = `${pageHead('error', 'request terminated')}<div class="notice error"><strong>ERROR:</strong> ${escapeHtml(error.message)}<br><br><code>Check INVIDIOUS_INSTANCE and INVIDIOUS_FALLBACKS on Render.</code></div>`;
}

function renderNotFound(message = 'Route not found') {
  app.innerHTML = `${pageHead('404', 'invalid target')}${emptyState(message, 'Return home or enter a new command.')}`;
}

function pageHead(title, subtitle = '', actions = '') {
  return `<header class="page-head"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</header>`;
}

function emptyState(title, text) {
  return `<div class="empty-state"><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div></div>`;
}

function selectFilter(name, options, current, emptyLabel = '') {
  return `<select class="filter-select" data-filter="${name}">${options.map((option) => `<option value="${option}" ${option === current ? 'selected' : ''}>${option || emptyLabel}</option>`).join('')}</select>`;
}

function channelSearchItem(item) {
  return `<a class="search-channel" href="#/channel?id=${encodeURIComponent(item.id)}">
    <div>${item.avatar ? `<img src="${escapeAttr(item.avatar)}" alt="">` : ''}</div>
    <div><h3>${escapeHtml(item.title)}${item.verified ? ' ✓' : ''}</h3><p>${formatNumber(item.subscribers)} subscribers · ${formatNumber(item.videos)} videos</p><p>${escapeHtml(item.description)}</p></div>
  </a>`;
}

function playlistSearchItem(item) {
  return `<a class="search-playlist" href="#/playlist?id=${encodeURIComponent(item.id)}">
    <div>${item.thumbnail ? `<img src="${escapeAttr(item.thumbnail)}" alt="">` : ''}</div>
    <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.author)} · ${item.videoCount} videos</p></div>
  </a>`;
}

function renderSuggestions() {
  if (!state.suggestions.length) return hideSuggestions();
  suggestionsBox.innerHTML = state.suggestions.map((value, index) => `<button type="button" class="${index === state.suggestionIndex ? 'active' : ''}" data-value="${escapeAttr(value)}">&gt; ${escapeHtml(value)}</button>`).join('');
  suggestionsBox.hidden = false;
}

function hideSuggestions() {
  suggestionsBox.hidden = true;
  state.suggestions = [];
  state.suggestionIndex = -1;
}

function updateActiveNav() {
  const { routeName } = parseHash();
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('active', link.dataset.route === routeName || (routeName === 'home' && link.dataset.route === 'home')));
}

function addHistory(video) {
  const item = toStoredVideo(video);
  const history = readStore(storage.history).filter((entry) => entry.id !== item.id);
  history.unshift(item);
  writeStore(storage.history, history.slice(0, 100));
}

function toggleFavorite(video) {
  const favorites = readStore(storage.favorites);
  const index = favorites.findIndex((entry) => entry.id === video.id);
  if (index >= 0) {
    favorites.splice(index, 1);
    toast('Removed from favourites.');
  } else {
    favorites.unshift(toStoredVideo(video));
    toast('Saved to favourites.');
  }
  writeStore(storage.favorites, favorites.slice(0, 200));
}

function isFavorite(id) {
  return readStore(storage.favorites).some((entry) => entry.id === id);
}

function toggleSubscription(channel) {
  if (!channel.id) return;
  const subscriptions = readStore(storage.subscriptions);
  const index = subscriptions.findIndex((entry) => entry.id === channel.id);
  if (index >= 0) {
    subscriptions.splice(index, 1);
    toast(`Unsubscribed from ${channel.name}.`);
  } else {
    subscriptions.unshift(channel);
    toast(`Subscribed locally to ${channel.name}.`);
  }
  writeStore(storage.subscriptions, subscriptions);
}

function isSubscribed(id) {
  return Boolean(id) && readStore(storage.subscriptions).some((entry) => entry.id === id);
}

function toStoredVideo(video) {
  return {
    type: 'video', id: video.id, title: video.title, author: video.author,
    authorId: video.authorId || '', verified: Boolean(video.verified || video.authorVerified),
    views: Number(video.views || 0), published: Number(video.published || 0),
    publishedText: video.publishedText || '', lengthSeconds: Number(video.lengthSeconds || 0),
    live: Boolean(video.live), thumbnail: video.thumbnail || `/api/thumb/${video.id}/hqdefault.jpg`,
  };
}

function readStore(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function writeStore(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function formatNumber(value) {
  const number = Number(value || 0);
  return new Intl.NumberFormat(undefined, { notation: number >= 1000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(number);
}

function formatDuration(seconds) {
  const total = Number(seconds || 0);
  if (!total) return '--:--';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function relativeDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '';
  const milliseconds = value < 1e12 ? value * 1000 : value;
  const delta = milliseconds - Date.now();
  const abs = Math.abs(delta);
  const units = [
    ['year', 31_536_000_000], ['month', 2_592_000_000], ['week', 604_800_000],
    ['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000],
  ];
  const [unit, size] = units.find(([, size]) => abs >= size) || ['second', 1000];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(delta / size), unit);
}

function extractVideoId(value) {
  if (validVideoId(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname.includes('youtu.be')) return validVideoId(url.pathname.slice(1)) ? url.pathname.slice(1) : '';
    const id = url.searchParams.get('v');
    return validVideoId(id) ? id : '';
  } catch { return ''; }
}
function validVideoId(value) { return /^[A-Za-z0-9_-]{11}$/.test(String(value || '')); }

function tickClock() {
  document.querySelector('#clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}

function toast(message, type = '') {
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.append(stack);
  }
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  stack.append(item);
  setTimeout(() => item.remove(), 3600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function escapeAttr(value) { return escapeHtml(value); }
function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}
