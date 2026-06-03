'use strict';
const express = require('express');
const cors = require('cors');
const https = require('https' );
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.4.0',
  name: 'TheTVApp (No-VPN)',
  description: 'Watch live TV channels without a VPN (Smart Proxy + Web Player)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' }],
  idPrefixes: ['thetvapp_']
};

const fallbackChannels = [
  {
    id: 'thetvapp_tlceast',
    type: 'tv',
    name: 'TLC USA Eastern',
    poster: 'https://thetvapp.to/img/channels/tlceast.png',
    url: 'https://thetvapp.to/hls/TLCEast/index.m3u8',
    genres: ['Live TV']
  },
  {
    id: 'thetvapp_aeeast',
    type: 'tv',
    name: 'A&E US Eastern Feed',
    poster: 'https://thetvapp.to/img/channels/aeeast.png',
    url: 'https://thetvapp.to/hls/AEEast/index.m3u8',
    genres: ['Live TV']
  },
  {
    id: 'thetvapp_amceast',
    type: 'tv',
    name: 'AMC Eastern Feed',
    poster: 'https://thetvapp.to/img/channels/amceast.png',
    url: 'https://thetvapp.to/hls/AMCEast/index.m3u8',
    genres: ['Live TV']
  }
];

let cachedChannels = [];
const streamCache = new Map( );
const guideCache = new Map();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanChannel(channel) {
  const id = String(channel.id || '').trim();
  const name = String(channel.name || id.replace(/^thetvapp_/, '')).trim();
  const url = String(channel.url || '').trim();
  if (!id || !url) return null;

  return {
    id,
    type: channel.type || 'tv',
    name,
    poster: channel.poster || channel.logo || '',
    logo: channel.logo || channel.poster || '',
    url,
    genres: Array.isArray(channel.genres) && channel.genres.length ? channel.genres : ['Live TV']
  };
}

function loadChannels() {
  const paths = [
    path.join(__dirname, 'channels.json'),
    path.join(__dirname, 'data', 'channels.json'),
    path.join(process.cwd(), 'channels.json'),
    path.join(process.cwd(), 'data', 'channels.json'),
    '/opt/render/project/src/channels.json',
    '/opt/render/project/src/data/channels.json'
  ];

  for (const filePath of paths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed)) continue;
      const cleaned = parsed.map(cleanChannel).filter(Boolean);
      if (cleaned.length > 0) {
        cachedChannels = cleaned;
        console.log(`Loaded ${cachedChannels.length} channels from ${filePath}`);
        return cachedChannels;
      }
    } catch (error) {
      console.error(`Could not load channels from ${filePath}:`, error.message);
    }
  }

  cachedChannels = fallbackChannels.map(cleanChannel).filter(Boolean);
  console.log(`Using fallback channel list with ${cachedChannels.length} channels`);
  return cachedChannels;
}

function getChannels() {
  if (!cachedChannels.length) loadChannels();
  return cachedChannels;
}

function getChannel(id) {
  return getChannels().find((channel) => channel.id === id);
}

function getStreamName(channel) {
  const match = String(channel.url || '').match(/\/hls\/([^/]+)\//i);
  if (match && match[1]) return match[1];
  return channel.id.replace(/^thetvapp_/, '');
}

function headers() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://thetvapp.to/',
    'Accept': '*/*'
  };
}

function httpsGetText(targetUrl ) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, { headers: headers( ) }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return resolve({ redirectedTo: response.headers.location, body: '' });
      }

      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body
      }));
    }).on('error', reject);
  });
}

async function discoverStreamUrl(channel) {
  const streamName = getStreamName(channel);
  const cached = streamCache.get(streamName);
  if (cached && (Date.now() - cached.timestamp < 300000)) {
    return cached.url;
  }

  const tvpassUrl = `https://tvpass.org/live/${encodeURIComponent(streamName )}/sd`;
  const first = await httpsGetText(tvpassUrl );
  const finalUrl = first.redirectedTo || tvpassUrl;
  
  streamCache.set(streamName, { url: finalUrl, timestamp: Date.now() });
  return finalUrl;
}

function encodeUrl(targetUrl) {
  return Buffer.from(targetUrl).toString('base64url');
}

function decodeUrl(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function absoluteBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host' )}`;
}

function proxiedUrl(req, targetUrl) {
  return `${absoluteBaseUrl(req)}/segment/${encodeUrl(targetUrl)}`;
}

function channelSummary(channel) {
  return {
    id: channel.id,
    type: 'tv',
    name: channel.name,
    poster: channel.poster,
    logo: channel.logo || channel.poster,
    description: `${channel.name} live TV channel`,
    genres: channel.genres || ['Live TV']
  };
}

function generateMockGuide(channelId, channelName) {
  const now = new Date();
  const guide = [];
  for (let i = 0; i < 6; i++) {
    const startTime = new Date(now.getTime() + i * 60 * 60 * 1000);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
    const programs = [`${channelName} News Update`, `Live Coverage`, `Documentary Special`, `Entertainment Tonight`, `Sports Highlights`, `Movie Feature` ];
    guide.push({
      start: startTime.toISOString(),
      end: endTime.toISOString(),
      title: programs[i % programs.length],
      description: `Currently airing on ${channelName}. Tune in now!`
    });
  }
  return guide;
}

function getChannelGuide(channelId) {
  const channel = getChannel(channelId);
  if (!channel) return [];
  const cacheKey = `guide_${channelId}`;
  const cached = guideCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < 1800000)) {
    return cached.data;
  }
  const guide = generateMockGuide(channelId, channel.name);
  guideCache.set(cacheKey, { data: guide, timestamp: Date.now() });
  return guide;
}

function renderWatchPage(req) {
  const baseUrl = absoluteBaseUrl(req);
  const channels = getChannels().map((channel) => ({
    id: channel.id,
    name: channel.name,
    poster: channel.poster || channel.logo || '',
    genres: channel.genres || ['Live TV'],
    playUrl: `${baseUrl}/play/${channel.id}/index.m3u8`
  }));

  const channelData = JSON.stringify(channels).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="TheTVApp">
  <title>TheTVApp Web Player</title>
  <style>
    :root { color-scheme: dark; --bg: #070b14; --panel: #101827; --panel2: #162033; --text: #f8fafc; --muted: #9ca3af; --accent: #22c55e; --border: #263246; --fav: #f59e0b; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(circle at top, #16233b 0%, var(--bg) 48%, #03050a 100%); color: var(--text); min-height: 100vh; overflow-x: hidden; }
    header { position: sticky; top: 0; z-index: 100; backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); background: rgba(7, 11, 20, 0.88); border-bottom: 1px solid var(--border); padding: 14px 16px; }
    h1 { margin: 0; font-size: 20px; line-height: 1.2; font-weight: 800; letter-spacing: -0.02em; }
    .topline { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    .status { color: var(--muted); font-size: 12px; font-weight: 500; }
    .search-container { position: relative; margin-top: 12px; }
    .search { width: 100%; padding: 12px 40px 12px 14px; border-radius: 12px; border: 1px solid var(--border); background: #0d1422; color: var(--text); font-size: 16px; outline: none; transition: border-color 0.2s; }
    .search:focus { border-color: var(--accent); }
    .clear-search { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--muted); font-size: 18px; cursor: pointer; display: none; }
    main { display: grid; grid-template-columns: 400px minmax(0, 1fr); gap: 20px; padding: 20px; max-width: 1400px; margin: 0 auto; }
    .playerPanel, .listPanel { background: rgba(16, 24, 39, 0.6); backdrop-filter: blur(10px); border: 1px solid var(--border); border-radius: 20px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.3); }
    .playerPanel { position: sticky; top: 110px; align-self: start; }
    .video-wrapper { position: relative; width: 100%; aspect-ratio: 16/9; background: #000; }
    video { width: 100%; height: 100%; display: block; }
    .loader { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5); display: none; z-index: 5; }
    .spinner { width: 40px; height: 40px; border: 4px solid rgba(255,255,255,0.1); border-top-color: var(--accent); border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .now { padding: 16px; border-top: 1px solid var(--border); }
    .now-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
    .now h2 { margin: 0 0 4px; font-size: 18px; font-weight: 700; }
    .now p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
    .guide-section { padding: 12px 0; border-top: 1px solid var(--border); }
    .guide-section h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; }
    .guide-item { padding: 8px 0; font-size: 13px; line-height: 1.4; }
    .guide-time { color: var(--accent); font-weight: 600; }
    .guide-title { color: var(--text); }
    .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .btn { appearance: none; border: none; border-radius: 10px; padding: 10px 16px; font-size: 14px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: opacity 0.2s; text-decoration: none; }
    .btn-primary { background: var(--accent); color: #052e16; }
    .btn-secondary { background: var(--panel2); color: var(--text); border: 1px solid var(--border); }
    .btn-fav.active { color: var(--fav); }
    .tabs { display: flex; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); overflow-x: auto; }
    .tab { background: none; border: none; color: var(--muted); font-size: 14px; font-weight: 600; padding: 6px 12px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
    .tab.active { background: var(--panel2); color: var(--text); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; padding: 16px; }
    .channel { appearance: none; border: 1px solid var(--border); background: linear-gradient(180deg, var(--panel2), #0d1422); color: var(--text); border-radius: 16px; padding: 12px; text-align: left; display: flex; flex-direction: column; gap: 8px; cursor: pointer; transition: transform 0.1s, border-color 0.2s; position: relative; }
    .channel.active { border-color: var(--accent); background: rgba(34,197,94,0.05); }
    .channel img { width: 100%; height: 48px; object-fit: contain; background: rgba(255,255,255,0.03); border-radius: 8px; padding: 4px; }
    .channel strong { font-size: 13px; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; height: 32px; }
    .channel-meta { display: flex; justify-content: space-between; align-items: center; margin-top: auto; }
    .channel span { color: var(--muted); font-size: 11px; font-weight: 500; }
    .fav-star { color: var(--muted); font-size: 14px; }
    .channel.is-fav .fav-star { color: var(--fav); }
    .recently-watched { padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .recently-watched h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; }
    .recent-list { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; }
    .recent-item { flex-shrink: 0; padding: 8px 12px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; font-size: 12px; cursor: pointer; white-space: nowrap; transition: border-color 0.2s; }
    .empty { padding: 40px 20px; text-align: center; color: var(--muted); font-size: 15px; }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; padding: 12px; gap: 12px; }
      .playerPanel { position: sticky; top: 0; z-index: 50; border-radius: 0; margin: -12px -12px 0 -12px; }
      .grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; padding: 10px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <h1>TheTVApp</h1>
      <div class="status"><span id="count">0</span> Channels</div>
    </div>
    <div class="search-container">
      <input id="search" class="search" type="search" placeholder="Search channels..." autocomplete="off">
      <button id="clearSearch" class="clear-search">&times;</button>
    </div>
  </header>
  <main>
    <section class="playerPanel">
      <div class="video-wrapper">
        <video id="video" controls playsinline preload="none"></video>
        <div id="loader" class="loader"><div class="spinner"></div></div>
      </div>
      <div class="now">
        <div class="now-header">
          <div>
            <h2 id="nowTitle">Welcome</h2>
            <p id="nowText">Select a channel to start watching.</p>
          </div>
          <button id="favBtn" class="btn btn-secondary btn-fav" style="display:none;" title="Toggle Favorite">★</button>
        </div>
        <div class="guide-section" id="guideSection" style="display:none;">
          <h3>Now & Next</h3>
          <div id="guideContent"></div>
        </div>
        <div class="actions">
          <a id="openLink" class="btn btn-primary" href="#" target="_blank" rel="noopener" style="display:none;">External Player</a>
          <button id="refreshBtn" class="btn btn-secondary" onclick="location.reload()">Refresh</button>
        </div>
      </div>
    </section>
    <section class="listPanel">
      <div id="recentlyWatched" class="recently-watched" style="display:none;">
        <h3>Recently Watched</h3>
        <div id="recentList" class="recent-list"></div>
      </div>
      <div class="tabs">
        <button class="tab active" data-tab="all">All Channels</button>
        <button class="tab" data-tab="favs">Favorites</button>
      </div>
      <div id="grid" class="grid"></div>
      <div id="empty" class="empty" style="display:none;">No channels found.</div>
    </section>
  </main>
  <script>
    const channels = ${channelData};
    const grid = document.getElementById('grid');
    const search = document.getElementById('search');
    const clearSearch = document.getElementById('clearSearch');
    const video = document.getElementById('video');
    const loader = document.getElementById('loader');
    const nowTitle = document.getElementById('nowTitle');
    const nowText = document.getElementById('nowText');
    const openLink = document.getElementById('openLink');
    const favBtn = document.getElementById('favBtn');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');
    const guideSection = document.getElementById('guideSection');
    const guideContent = document.getElementById('guideContent');
    const recentlyWatched = document.getElementById('recentlyWatched');
    const recentList = document.getElementById('recentList');
    const tabs = document.querySelectorAll('.tab');
    let activeId = '';
    let currentTab = 'all';
    let favorites = JSON.parse(localStorage.getItem('thetvapp_favs') || '[]');
    let recentChannels = JSON.parse(localStorage.getItem('thetvapp_recent') || '[]');
    count.textContent = channels.length;
    function saveFavs() { localStorage.setItem('thetvapp_favs', JSON.stringify(favorites)); }
    function saveRecent() { localStorage.setItem('thetvapp_recent', JSON.stringify(recentChannels)); }
    function toggleFav(id, e) {
      if (e) e.stopPropagation();
      const index = favorites.indexOf(id);
      if (index > -1) favorites.splice(index, 1);
      else favorites.push(id);
      saveFavs(); render(); updateFavBtn();
    }
    function updateFavBtn() {
      if (!activeId) return;
      favBtn.style.display = 'flex';
      favBtn.classList.toggle('active', favorites.includes(activeId));
    }
    favBtn.onclick = () => toggleFav(activeId);
    function addToRecent(id) {
      recentChannels = recentChannels.filter(c => c !== id);
      recentChannels.unshift(id);
      if (recentChannels.length > 10) recentChannels.pop();
      saveRecent(); renderRecent();
    }
    function renderRecent() {
      if (recentChannels.length === 0) { recentlyWatched.style.display = 'none'; return; }
      recentlyWatched.style.display = 'block';
      recentList.innerHTML = '';
      for (const id of recentChannels) {
        const chan = channels.find(c => c.id === id);
        if (!chan) continue;
        const btn = document.createElement('button');
        btn.className = 'recent-item';
        btn.textContent = chan.name;
        btn.onclick = () => play(chan);
        recentList.appendChild(btn);
      }
    }
    function updateGuide(channelId) {
      fetch(\`/api/guide/\${channelId}\`).then(r => r.json()).then(data => {
        if (!data.guide || data.guide.length === 0) { guideSection.style.display = 'none'; return; }
        guideSection.style.display = 'block';
        guideContent.innerHTML = '';
        for (let i = 0; i < Math.min(2, data.guide.length); i++) {
          const prog = data.guide[i];
          const time = new Date(prog.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          const item = document.createElement('div');
          item.className = 'guide-item';
          item.innerHTML = \`<span class="guide-time">\${time}</span> <span class="guide-title">\${prog.title}</span>\`;
          guideContent.appendChild(item);
        }
      }).catch(() => { guideSection.style.display = 'none'; });
    }
    function play(channel, skipScroll = false) {
      if (activeId === channel.id) return;
      activeId = channel.id;
      addToRecent(channel.id);
      loader.style.display = 'flex';
      video.src = channel.playUrl;
      video.load();
      video.play().catch(() => { loader.style.display = 'none'; });
      nowTitle.textContent = channel.name;
      nowText.textContent = 'Live Stream · ' + (channel.genres[0] || 'Live TV');
      openLink.href = channel.playUrl;
      openLink.style.display = 'inline-flex';
      updateGuide(channel.id); updateFavBtn(); render();
      if (!skipScroll && window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    video.onwaiting = () => loader.style.display = 'flex';
    video.onplaying = () => loader.style.display = 'none';
    video.onerror = () => { loader.style.display = 'none'; nowText.textContent = 'Error loading stream.'; };
    function render() {
      const q = search.value.trim().toLowerCase();
      clearSearch.style.display = q ? 'block' : 'none';
      let visible = channels.filter(c => c.name.toLowerCase().includes(q));
      if (currentTab === 'favs') visible = visible.filter(c => favorites.includes(c.id));
      grid.innerHTML = '';
      empty.style.display = visible.length ? 'none' : 'block';
      for (const channel of visible) {
        const isFav = favorites.includes(channel.id);
        const button = document.createElement('button');
        button.className = 'channel' + (channel.id === activeId ? ' active' : '') + (isFav ? ' is-fav' : '');
        button.onclick = () => play(channel);
        const img = document.createElement('img');
        img.loading = 'lazy'; img.src = channel.poster || '';
        img.onerror = () => img.style.visibility = 'hidden';
        const name = document.createElement('strong');
        name.textContent = channel.name;
        const meta = document.createElement('div');
        meta.className = 'channel-meta';
        const genre = document.createElement('span');
        genre.textContent = (channel.genres && channel.genres[0]) || 'Live TV';
        const star = document.createElement('span');
        star.className = 'fav-star'; star.textContent = isFav ? '★' : '☆';
        star.onclick = (e) => toggleFav(channel.id, e);
        meta.appendChild(genre); meta.appendChild(star);
        button.appendChild(img); button.appendChild(name); button.appendChild(meta);
        grid.appendChild(button);
      }
    }
    search.addEventListener('input', render);
    clearSearch.onclick = () => { search.value = ''; render(); search.focus(); };
    tabs.forEach(tab => {
      tab.onclick = () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active'); currentTab = tab.dataset.tab; render();
      };
    });
    renderRecent(); render();
  </script>
</body>
</html>\`;
}

app.get('/', (req, res) => {
  res.json({ name: manifest.name, version: manifest.version, channelCount: getChannels().length, webPlayer: \`\${absoluteBaseUrl(req)}/watch\`, manifest: \`\${absoluteBaseUrl(req)}/manifest.json\`, health: 'OK' });
});

app.get('/ping', (req, res) => res.send('pong'));

app.get('/watch', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(renderWatchPage(req));
});

app.get('/api/guide/:id', (req, res) => {
  const guide = getChannelGuide(req.params.id);
  res.json({ guide });
});

app.get('/channels.json', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ channels: getChannels().map((channel) => ({
    id: channel.id,
    name: channel.name,
    poster: channel.poster,
    genres: channel.genres || ['Live TV'],
    playUrl: \`\${absoluteBaseUrl(req)}/play/\${channel.id}/index.m3u8\`
  })) });
});

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = getChannels().map(channelSummary);
  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.json({ meta: null });
  res.json({
    meta: {
      ...channelSummary(channel),
      background: channel.poster,
      runtime: 'Live',
      videos: [{ id: channel.id, title: 'Live TV' }]
    }
  });
});

app.get('/stream/tv/:id.json', (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.json({ streams: [] });
  res.json({
    streams: [{
      name: 'Smart Relay',
      title: channel.name,
      url: \`\${absoluteBaseUrl(req)}/play/\${channel.id}/index.m3u8\`,
      behaviorHints: { notWebReady: false }
    }]
  });
});

app.get('/play/:id/index.m3u8', async (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).send('Channel Not Found');
  try {
    const realStreamUrl = await discoverStreamUrl(channel);
    const playlist = await httpsGetText(realStreamUrl );
    if (!playlist.body || !playlist.body.includes('#EXTM3U')) {
      return res.status(502).type('text/plain').send('Could not load playlist');
    }
    const rewritten = playlist.body.split(/\\r?\\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const target = new URL(trimmed, realStreamUrl).href;
      return proxiedUrl(req, target);
    }).join('\\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(rewritten);
  } catch (error) {
    res.status(500).type('text/plain').send(\`Discovery Failed: \${error.message}\`);
  }
});

app.get('/segment/:encoded', (req, res) => {
  let targetUrl;
  try { targetUrl = decodeUrl(req.params.encoded); } catch (error) { return res.status(400).send('Bad segment URL'); }
  https.get(targetUrl, { headers: headers( ) }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' });
    proxyRes.pipe(res);
  }).on('error', (error) => res.status(500).send(error.message));
});

loadChannels();
app.listen(PORT, '0.0.0.0', () => console.log(\`Smart Proxy v\${manifest.version} live on \${PORT}\`));
module.exports = app;
