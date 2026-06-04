'use strict';
const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

// Enhanced manifest supporting live TV, movies, and series
const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.3.0',
  name: 'TheTVApp (No-VPN + Torrentio)',
  description: 'Watch live TV channels and on-demand movies/series via Torrentio (Smart Proxy + Web Player)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv', 'movie', 'series'],
  catalogs: [
    { type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' },
    { type: 'movie', id: 'torrentio_movies', name: 'Popular Movies (Torrentio)', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'torrentio_series', name: 'Popular Series (Torrentio)', extra: [{ name: 'search' }, { name: 'skip' }] }
  ],
  idPrefixes: ['thetvapp_', 'tt', 'kitsu']
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

function httpsGetText(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, { headers: headers() }, (response) => {
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

function httpGetJson(targetUrl) {
  return new Promise((resolve, reject) => {
    const protocol = targetUrl.startsWith('https') ? https : http;
    protocol.get(targetUrl, { headers: headers() }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function discoverStreamUrl(channel) {
  const streamName = getStreamName(channel);
  const tvpassUrl = `https://tvpass.org/live/${encodeURIComponent(streamName)}/sd`;
  const first = await httpsGetText(tvpassUrl);
  return first.redirectedTo || tvpassUrl;
}

function encodeUrl(targetUrl) {
  return Buffer.from(targetUrl).toString('base64url');
}

function decodeUrl(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function absoluteBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
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

// Torrentio integration functions
async function queryTorrentio(id, type) {
  try {
    const endpoint = `https://torrentio.strem.fun/stream/${type}/${id}.json`;
    const result = await httpGetJson(endpoint);
    return result.streams || [];
  } catch (error) {
    console.error(`Failed to query Torrentio for ${type}/${id}:`, error.message);
    return [];
  }
}

async function queryCinemeta(id, type) {
  try {
    const endpoint = `https://v3-cinemeta.strem.io/meta/${type}/${id}.json`;
    const result = await httpGetJson(endpoint);
    return result.meta || null;
  } catch (error) {
    console.error(`Failed to query Cinemeta for ${type}/${id}:`, error.message);
    return null;
  }
}

function renderWatchPage(req) {
  const baseUrl = absoluteBaseUrl(req);
  const channels = getChannels().map((channel) => ({
    id: channel.id,
    name: channel.name,
    poster: channel.poster || channel.logo || '',
    genres: channel.genres || ['Live TV'],
    playUrl: `${baseUrl}/play/${channel.id}/index.m3u8`,
    type: 'tv'
  }));

  const channelData = JSON.stringify(channels).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="TheTVApp">
  <title>TheTVApp Web Player</title>
  <style>
    :root { color-scheme: dark; --bg: #070b14; --panel: #101827; --panel2: #162033; --text: #f8fafc; --muted: #9ca3af; --accent: #22c55e; --border: #263246; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(circle at top, #16233b 0%, var(--bg) 48%, #03050a 100%); color: var(--text); min-height: 100vh; }
    header { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(18px); background: rgba(7, 11, 20, 0.88); border-bottom: 1px solid var(--border); padding: 14px 16px; }
    h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.2; }
    .topline { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .status { color: var(--muted); font-size: 13px; }
    .tabs { display: flex; gap: 8px; margin-top: 12px; border-bottom: 1px solid var(--border); }
    .tab { padding: 10px 14px; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .search { width: 100%; margin-top: 12px; padding: 13px 14px; border-radius: 14px; border: 1px solid var(--border); background: #0d1422; color: var(--text); font-size: 16px; outline: none; }
    main { display: grid; grid-template-columns: 390px minmax(0, 1fr); gap: 16px; padding: 16px; max-width: 1320px; margin: 0 auto; }
    .playerPanel, .listPanel { background: rgba(16, 24, 39, 0.92); border: 1px solid var(--border); border-radius: 18px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,.28); }
    .playerPanel { position: sticky; top: 96px; align-self: start; }
    video { width: 100%; min-height: 220px; background: #000; display: block; }
    .now { padding: 14px; }
    .now h2 { margin: 0 0 6px; font-size: 18px; }
    .now p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
    .openLink { display: inline-block; margin-top: 12px; padding: 11px 13px; border-radius: 12px; color: #052e16; background: var(--accent); font-weight: 700; text-decoration: none; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 12px; }
    .channel { appearance: none; border: 1px solid var(--border); background: linear-gradient(180deg, var(--panel2), #0d1422); color: var(--text); border-radius: 16px; padding: 12px; min-height: 102px; text-align: left; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
    .channel:active, .channel.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(34,197,94,.22); }
    .channel img { width: 54px; height: 36px; object-fit: contain; background: rgba(255,255,255,.05); border-radius: 8px; }
    .channel strong { font-size: 14px; line-height: 1.25; }
    .channel span { color: var(--muted); font-size: 12px; }
    .empty { padding: 24px; color: var(--muted); }
    .loading { padding: 24px; color: var(--muted); text-align: center; }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; padding: 10px; }
      .playerPanel { position: static; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-bottom: 28px; }
      h1 { font-size: 20px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <h1>TheTVApp Web Player</h1>
      <div class="status"><span id="count"></span> items · Version ${escapeHtml(manifest.version)}</div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="live">Live TV</button>
      <button class="tab" data-tab="movies">Movies</button>
      <button class="tab" data-tab="series">Series</button>
    </div>
    <input id="search" class="search" type="search" placeholder="Search channels..." autocomplete="off">
  </header>
  <main>
    <section class="playerPanel">
      <video id="video" controls playsinline webkit-playsinline preload="none"></video>
      <div class="now">
        <h2 id="nowTitle">Pick a channel</h2>
        <p id="nowText">Tap any item below. On iPhone or iPad, if the embedded player does not start, use the green Open Stream button.</p>
        <a id="openLink" class="openLink" href="#" target="_blank" rel="noopener" style="display:none;">Open Stream</a>
      </div>
    </section>
    <section class="listPanel">
      <div id="grid" class="grid"></div>
      <div id="empty" class="empty" style="display:none;">No items found.</div>
      <div id="loading" class="loading" style="display:none;">Loading...</div>
    </section>
  </main>
  <script>
    const channels = ${channelData};
    const grid = document.getElementById('grid');
    const search = document.getElementById('search');
    const video = document.getElementById('video');
    const nowTitle = document.getElementById('nowTitle');
    const nowText = document.getElementById('nowText');
    const openLink = document.getElementById('openLink');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');
    const loading = document.getElementById('loading');
    const tabs = document.querySelectorAll('.tab');
    let activeId = '';
    let currentTab = 'live';
    let items = channels;

    count.textContent = items.length;

    tabs.forEach(tab => {
      tab.addEventListener('click', async () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        search.value = '';
        search.placeholder = currentTab === 'live' ? 'Search channels...' : 'Search ' + currentTab + '...';
        
        if (currentTab === 'live') {
          items = channels;
          render();
        } else {
          loading.style.display = 'block';
          grid.innerHTML = '';
          empty.style.display = 'none';
          loading.innerHTML = 'On-demand content search requires additional backend logic. Use the Stremio API endpoints directly for now.';
        }
      });
    });

    function play(item) {
      activeId = item.id;
      if (item.type === 'tv') {
        video.src = item.playUrl;
      } else {
        video.src = '';
      }
      video.load();
      const maybePromise = video.play();
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
      nowTitle.textContent = item.name;
      nowText.textContent = 'If playback does not begin, tap Play in the video controls or use Open Stream.';
      openLink.href = item.playUrl || '#';
      openLink.style.display = item.playUrl ? 'inline-block' : 'none';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function render() {
      const q = search.value.trim().toLowerCase();
      const visible = items.filter((item) => item.name.toLowerCase().includes(q));
      grid.innerHTML = '';
      empty.style.display = visible.length ? 'none' : 'block';
      loading.style.display = 'none';

      for (const item of visible) {
        const button = document.createElement('button');
        button.className = 'channel' + (item.id === activeId ? ' active' : '');
        button.type = 'button';
        button.onclick = () => play(item);

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = item.poster || '';
        img.onerror = () => { img.style.display = 'none'; };

        const name = document.createElement('strong');
        name.textContent = item.name;

        const genre = document.createElement('span');
        genre.textContent = (item.genres && item.genres[0]) || 'Live TV';

        button.appendChild(img);
        button.appendChild(name);
        button.appendChild(genre);
        grid.appendChild(button);
      }
    }

    search.addEventListener('input', render);
    render();
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.json({
    name: manifest.name,
    version: manifest.version,
    channelCount: getChannels().length,
    webPlayer: `${absoluteBaseUrl(req)}/watch`,
    manifest: `${absoluteBaseUrl(req)}/manifest.json`
  });
});

app.get('/watch', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(renderWatchPage(req));
});

app.get('/channels.json', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ channels: getChannels().map((channel) => ({
    id: channel.id,
    name: channel.name,
    poster: channel.poster,
    genres: channel.genres || ['Live TV'],
    playUrl: `${absoluteBaseUrl(req)}/play/${channel.id}/index.m3u8`
  })) });
});

app.get('/manifest.json', (req, res) => res.json(manifest));

// Live TV catalog
app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = getChannels().map(channelSummary);
  res.json({ metas });
});

// Movie catalog (Torrentio) - Placeholder
app.get('/catalog/movie/torrentio_movies.json', (req, res) => {
  res.json({ metas: [] });
});

// Series catalog (Torrentio) - Placeholder
app.get('/catalog/series/torrentio_series.json', (req, res) => {
  res.json({ metas: [] });
});

// Live TV metadata
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

// Movie metadata (from Cinemeta)
app.get('/meta/movie/:id.json', async (req, res) => {
  try {
    const meta = await queryCinemeta(req.params.id, 'movie');
    res.json({ meta });
  } catch (error) {
    res.json({ meta: null });
  }
});

// Series metadata (from Cinemeta)
app.get('/meta/series/:id.json', async (req, res) => {
  try {
    const meta = await queryCinemeta(req.params.id, 'series');
    res.json({ meta });
  } catch (error) {
    res.json({ meta: null });
  }
});

// Live TV streams
app.get('/stream/tv/:id.json', (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.json({ streams: [] });

  res.json({
    streams: [{
      name: 'Smart Relay',
      title: channel.name,
      url: `${absoluteBaseUrl(req)}/play/${channel.id}/index.m3u8`,
      behaviorHints: { notWebReady: false }
    }]
  });
});

// Movie streams (from Torrentio)
app.get('/stream/movie/:id.json', async (req, res) => {
  try {
    const streams = await queryTorrentio(req.params.id, 'movie');
    res.json({ streams });
  } catch (error) {
    res.json({ streams: [] });
  }
});

// Series streams (from Torrentio)
app.get('/stream/series/:id.json', async (req, res) => {
  try {
    const streams = await queryTorrentio(req.params.id, 'series');
    res.json({ streams });
  } catch (error) {
    res.json({ streams: [] });
  }
});

app.get('/play/:id/index.m3u8', async (req, res) => {
  const channel = getChannel(req.params.id);
  if (!channel) return res.status(404).send('Channel Not Found');

  try {
    const realStreamUrl = await discoverStreamUrl(channel);
    const playlist = await httpsGetText(realStreamUrl);

    if (!playlist.body || !playlist.body.includes('#EXTM3U')) {
      return res.status(502).type('text/plain').send('Could not load playlist');
    }

    const rewritten = playlist.body.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const target = new URL(trimmed, realStreamUrl).href;
      return proxiedUrl(req, target);
    }).join('\n');

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.send(rewritten);
  } catch (error) {
    res.status(500).type('text/plain').send(`Discovery Failed: ${error.message}`);
  }
});

app.get('/segment/:encoded', (req, res) => {
  let targetUrl;
  try {
    targetUrl = decodeUrl(req.params.encoded);
  } catch (error) {
    return res.status(400).send('Bad segment URL');
  }

  https.get(targetUrl, { headers: headers() }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  }).on('error', (error) => res.status(500).send(error.message));
});

loadChannels();

app.listen(PORT, '0.0.0.0', () => console.log(`TheTVApp v${manifest.version} live on ${PORT}`));

module.exports = app;
