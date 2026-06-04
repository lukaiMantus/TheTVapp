'use strict';
const express = require('express');
const cors = require('cors');
const https = require('https');

const axios = require('axios');
const TMDB_API_KEY = process.env.TMDB_API_KEY || '138d106138fe4cafc7105aa1c835f4c4';
const NOTORRENT_API = 'https://addon-osvh.onrender.com';

function cleanText(str) {
  if (!str) return '';
  return str.replace(/[^\x00-\x7F\u00C0-\u017F\u0100-\uFFFF]/g, '').trim();
}

function extractQuality(titleText) {
  const raw = titleText || '';
  const match = raw.match(/(\d{3,4}p)/);
  if (match) return match[0];
  if (raw.toUpperCase().includes('FREE')) return 'Auto';
  return 'Unknown';
}

async function getNotorrentStreams(tmdbId, mediaType = 'movie', seasonNum = null, episodeNum = null) {
  console.log(`[NoTorrent] Searching for ${mediaType} ${tmdbId}`);
  if (!TMDB_API_KEY || TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE') {
    console.error('[NoTorrent] No TMDB API key configured. Please set TMDB_API_KEY environment variable.');
    return [];
  }

  let imdbId;
  try {
    const type = mediaType === 'tv' ? 'tv' : 'movie';
    const { data } = await axios.get(
      `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`,
      { timeout: 8000 }
    );
    imdbId = (data.external_ids && data.external_ids.imdb_id) || null;
  } catch (err) {
    console.error(`[NoTorrent] TMDB lookup failed: ${err.message}`);
    return [];
  }

  if (!imdbId) {
    console.warn('[NoTorrent] Failed to map IMDB ID from TMDB.');
    return [];
  }

  const apiUrl = (mediaType === 'tv' && seasonNum != null) ?
    `${NOTORRENT_API}/stream/series/${imdbId}:${seasonNum}:${episodeNum}.json` :
    `${NOTORRENT_API}/stream/movie/${imdbId}.json`;

  try {
    const { data } = await axios.get(apiUrl, { timeout: 20000 });
    const rawList = data.streams || [];
    const streams = [];
    for (const item of rawList) {
      if (item.externalUrl || !item.url) continue;
      if (item.url.includes('github.com') || item.url.includes('googleusercontent')) continue;

      const cleanTitleStr = cleanText(item.title || '');
      const quality = extractQuality(cleanTitleStr);
      let language = 'Default';
      const langMatch = cleanTitleStr.match(/\(([^)]+)\)/);
      if (langMatch) {
        language = langMatch[1].charAt(0).toUpperCase() + langMatch[1].slice(1).toLowerCase();
      }

      const proxyHeaders = (item.behaviorHints?.proxyHeaders?.request) || {};
      const headers = { ...(item.behaviorHints?.headers || {}), ...proxyHeaders };

      const nameParts = ['NoTorrent', language, quality];
      if (item.episode) nameParts.push(`E${item.episode}`);
      if (item.season) nameParts.push(`S${item.season}`);

      streams.push({
        title: cleanTitleStr,
        url: item.url,
        quality: quality,
        provider: 'notorrent',
        headers: headers,
        name: nameParts.filter(Boolean).join(' ')
      });
    }
    return streams;
  } catch (error) {
    console.error(`[NoTorrent] Stream fetch failed: ${error.message}`);
    return [];
  }
}

const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.3.0',
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
  <meta name="apple-mobile-web-app-title" content="TheTVApp">
  <title>TheTVApp Web Player</title>
  <style>
    :root { color-scheme: dark; --bg: #070b14; --panel: #101827; --panel2: #162033; --text: #f8fafc; --muted: #9ca3af; --accent: #22c55e; --border: #263246; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(circle at top, #16233b 0%, var(--bg) 48%, #03050a 100%); color: var(--text); min-height: 100vh; }
    header { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(18px); background: rgba(7, 11, 20, 0.88); border-bottom: 1px solid var(--border); padding: 14px 16px; }
    h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.2; }
    .tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .tab { background: var(--panel2); border: 1px solid var(--border); border-radius: 12px; padding: 8px 16px; color: var(--text); font-size: 16px; cursor: pointer; }
    .tab.active { background: var(--accent); color: #052e16; border-color: var(--accent); }
    .topline { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .status { color: var(--muted); font-size: 13px; }
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
    .movie-poster { appearance: none; border: 1px solid var(--border); background: linear-gradient(180deg, var(--panel2), #0d1422); color: var(--text); border-radius: 16px; padding: 12px; min-height: 102px; text-align: center; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
    .movie-poster:active, .movie-poster.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(34,197,94,.22); }
    .movie-poster img { width: 100%; height: auto; object-fit: cover; border-radius: 8px; margin-bottom: 8px; }
    .movie-poster strong { font-size: 14px; line-height: 1.25; }
    .empty { padding: 24px; color: var(--muted); }
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
      <div class="tabs">
        <button id="liveTvTab" class="tab active">Live TV</button>
        <button id="moviesTab" class="tab">Movies</button>
      </div>
      <div class="status"><span id="count"></span> channels · Version ${escapeHtml(manifest.version)}</div>
    </div>
    <h1>TheTVApp Web Player</h1>
    <input id="liveTvSearch" class="search" type="search" placeholder="Search channels..." autocomplete="off">
    <input id="movieSearch" class="search" type="search" placeholder="Search movies..." autocomplete="off" style="display:none;">
  </header>
  <main>
    <section class="playerPanel">
      <video id="video" controls playsinline webkit-playsinline preload="none"></video>
      <div class="now">
        <h2 id="nowTitle">Pick a channel</h2>
        <p id="nowText">Tap any channel below. On iPhone or iPad, if the embedded player does not start, use the green Open Stream button.</p>
        <a id="openLink" class="openLink" href="#" target="_blank" rel="noopener" style="display:none;">Open Stream</a>
      </div>
    </section>
    <section class="listPanel">
      <div id="liveTvGrid" class="grid"></div>
      <div id="movieGrid" class="grid" style="display:none;"></div>
      <div id="empty" class="empty" style="display:none;">No results found.</div>
    </section>
  </main>
  <script>
    const channels = ${channelData};
    let movies = [];
    let activeView = 'liveTv';
    let activeId = '';

    const liveTvTab = document.getElementById('liveTvTab');
    const moviesTab = document.getElementById('moviesTab');
    const liveTvSearch = document.getElementById('liveTvSearch');
    const movieSearch = document.getElementById('movieSearch');
    const liveTvGrid = document.getElementById('liveTvGrid');
    const movieGrid = document.getElementById('movieGrid');
    const video = document.getElementById('video');
    const nowTitle = document.getElementById('nowTitle');
    const nowText = document.getElementById('nowText');
    const openLink = document.getElementById('openLink');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');

    count.textContent = channels.length;

    liveTvTab.addEventListener('click', () => switchView('liveTv'));
    moviesTab.addEventListener('click', () => switchView('movies'));
    liveTvSearch.addEventListener('input', renderLiveTv);
    movieSearch.addEventListener('input', debounce(searchMovies, 500));

    function switchView(view) {
      activeView = view;
      if (activeView === 'liveTv') {
        liveTvTab.classList.add('active');
        moviesTab.classList.remove('active');
        liveTvSearch.style.display = 'block';
        movieSearch.style.display = 'none';
        liveTvGrid.style.display = 'grid';
        movieGrid.style.display = 'none';
        renderLiveTv();
      } else {
        liveTvTab.classList.remove('active');
        moviesTab.classList.add('active');
        liveTvSearch.style.display = 'none';
        movieSearch.style.display = 'block';
        liveTvGrid.style.display = 'none';
        movieGrid.style.display = 'grid';
        if (movies.length === 0) searchMovies();
        renderMovies();
      }
    }

    function debounce(func, delay) {
      let timeout;
      return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
      };
    }

    async function searchMovies() {
      const query = movieSearch.value.trim();
      if (query.length < 3) {
        movies = [];
        renderMovies();
        return;
      }
      try {
        const response = await fetch('/api/movies/search?query=' + encodeURIComponent(query));
        movies = await response.json();
        renderMovies();
      } catch (error) {
        console.error('Error searching movies:', error);
        movies = [];
        renderMovies();
      }
    }

    function play(channel) {
      activeId = channel.id;
      video.src = channel.playUrl;
      video.load();
      const maybePromise = video.play();
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
      nowTitle.textContent = channel.name;
      nowText.textContent = 'If playback does not begin, tap Play in the video controls or use Open Stream.';
      openLink.href = channel.playUrl;
      openLink.style.display = 'inline-block';
      renderLiveTv();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function playMovie(movie) {
      nowTitle.textContent = movie.title;
      nowText.textContent = 'Loading movie stream...';
      openLink.style.display = 'none';
      video.src = '';

      fetch('/api/movies/stream?tmdbId=' + movie.id)
        .then(response => response.json())
        .then(data => {
          if (data.url) {
            video.src = data.url;
            video.load();
            const maybePromise = video.play();
            if (maybePromise && typeof maybePromise.catch === 'function') {
              maybePromise.catch(() => {});
            }
            nowText.textContent = 'If playback does not begin, tap Play in the video controls or use Open Stream.';
            openLink.href = data.url;
            openLink.style.display = 'inline-block';
          } else {
            nowText.textContent = 'Failed to load movie stream.';
          }
        })
        .catch(error => {
          console.error('Error fetching movie stream:', error);
          nowText.textContent = 'Failed to load movie stream.';
        });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function renderLiveTv() {
      const q = liveTvSearch.value.trim().toLowerCase();
      const visible = channels.filter((channel) => channel.name.toLowerCase().includes(q));
      liveTvGrid.innerHTML = '';
      empty.style.display = visible.length ? 'none' : 'block';

      for (const channel of visible) {
        const button = document.createElement('button');
        button.className = 'channel' + (channel.id === activeId ? ' active' : '');
        button.type = 'button';
        button.onclick = () => play(channel);

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = channel.poster || '';
        img.onerror = () => { img.style.display = 'none'; };

        const name = document.createElement('strong');
        name.textContent = channel.name;

        const genre = document.createElement('span');
        genre.textContent = (channel.genres && channel.genres[0]) || 'Live TV';

        button.appendChild(img);
        button.appendChild(name);
        button.appendChild(genre);
        liveTvGrid.appendChild(button);
      }
    }

    function renderMovies() {
      movieGrid.innerHTML = '';
      empty.style.display = movies.length ? 'none' : 'block';

      for (const movie of movies) {
        const button = document.createElement('button');
        button.className = 'movie-poster';
        button.type = 'button';
        button.onclick = () => playMovie(movie);

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = movie.title;
        img.src = movie.poster_path || '';
        img.onerror = () => { img.style.display = 'none'; };

        const title = document.createElement('strong');
        title.textContent = movie.title;

        button.appendChild(img);
        button.appendChild(title);
        movieGrid.appendChild(button);
      }
    }

    switchView('liveTv');
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


app.get('/api/movies/search', async (req, res) => {
  const query = req.query.query;
  if (!query) return res.status(400).json({ error: 'Query parameter is required' });

  try {
    const { data } = await axios.get(
      `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}`,
      { timeout: 8000 }
    );
    const movies = data.results.map(movie => ({
      id: movie.id,
      title: movie.title,
      poster_path: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
      release_date: movie.release_date
    }));
    res.json(movies);
  } catch (error) {
    console.error(`TMDB movie search failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to search movies' });
  }
});

app.get('/api/movies/stream', async (req, res) => {
  const tmdbId = req.query.tmdbId;
  if (!tmdbId) return res.status(400).json({ error: 'TMDB ID is required' });

  try {
    const streams = await getNotorrentStreams(tmdbId, 'movie');
    if (streams.length > 0) {
      const streamUrl = streams[0].url;
      const proxiedStreamUrl = `${absoluteBaseUrl(req)}/segment/${encodeUrl(streamUrl)}`;
      res.json({ url: proxiedStreamUrl });
    } else {
      res.status(404).json({ error: 'No streams found for this movie' });
    }
  } catch (error) {
    console.error(`Movie stream fetch failed: ${error.message}`);
    res.status(500).json({ error: 'Failed to get movie stream' });
  }
});

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

app.listen(PORT, '0.0.0.0', () => console.log(`Smart Proxy v1.3.0 live on ${PORT}`));

module.exports = app;
