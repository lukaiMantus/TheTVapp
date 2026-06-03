'use strict';
const express = require('express');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.2.1',
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

const HTTP_TIMEOUT_MS = 18000;

function httpsGetText(targetUrl) {
  return new Promise((resolve, reject) => {
    const request = https.get(targetUrl, { headers: headers(), timeout: HTTP_TIMEOUT_MS }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve({ redirectedTo: response.headers.location, body: '' });
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body
      }));
    });

    request.setTimeout(HTTP_TIMEOUT_MS, () => {
      request.destroy(new Error('Upstream request timed out'));
    });

    request.on('error', reject);
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
    :root { color-scheme: dark; --bg: #070b14; --panel: #101827; --panel2: #162033; --text: #f8fafc; --muted: #9ca3af; --accent: #22c55e; --warn: #f59e0b; --bad: #ef4444; --border: #263246; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(circle at top, #16233b 0%, var(--bg) 48%, #03050a 100%); color: var(--text); min-height: 100vh; }
    header { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(18px); background: rgba(7, 11, 20, 0.90); border-bottom: 1px solid var(--border); padding: 14px 16px; }
    h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.2; }
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
    .notice { margin-top: 10px; padding: 10px 11px; border-radius: 12px; background: rgba(34,197,94,.10); border: 1px solid rgba(34,197,94,.28); color: #bbf7d0; font-size: 13px; line-height: 1.35; }
    .notice.warn { background: rgba(245,158,11,.11); border-color: rgba(245,158,11,.35); color: #fde68a; }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .btn, .openLink { appearance: none; border: 0; display: inline-block; padding: 11px 13px; border-radius: 12px; color: #052e16; background: var(--accent); font-weight: 700; text-decoration: none; font-size: 14px; cursor: pointer; }
    .btn.secondary { color: var(--text); background: #243044; border: 1px solid var(--border); }
    .toggle { margin-top: 12px; display: flex; gap: 9px; align-items: flex-start; color: var(--muted); font-size: 13px; line-height: 1.35; }
    .toggle input { width: 20px; height: 20px; accent-color: var(--accent); margin-top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 12px; }
    .channel { appearance: none; border: 1px solid var(--border); background: linear-gradient(180deg, var(--panel2), #0d1422); color: var(--text); border-radius: 16px; padding: 12px; min-height: 102px; text-align: left; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
    .channel:active, .channel.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(34,197,94,.22); }
    .channel img { width: 54px; height: 36px; object-fit: contain; background: rgba(255,255,255,.05); border-radius: 8px; }
    .channel strong { font-size: 14px; line-height: 1.25; }
    .channel span { color: var(--muted); font-size: 12px; }
    .empty { padding: 24px; color: var(--muted); }
    @media (max-width: 820px) {
      header { padding: 12px; }
      main { grid-template-columns: 1fr; padding: 10px; }
      .playerPanel { position: static; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-bottom: 28px; }
      h1 { font-size: 20px; }
      video { min-height: 205px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <h1>TheTVApp Web Player</h1>
      <div class="status"><span id="count"></span> channels · Version ${escapeHtml(manifest.version)}</div>
    </div>
    <input id="search" class="search" type="search" placeholder="Search channels..." autocomplete="off">
  </header>
  <main>
    <section class="playerPanel">
      <video id="video" controls playsinline webkit-playsinline preload="metadata"></video>
      <div class="now">
        <h2 id="nowTitle">Pick a channel</h2>
        <p id="nowText">Tap any channel below. The player now has slow Wi‑Fi recovery, automatic reconnects, and simple retry buttons.</p>
        <div id="notice" class="notice" style="display:none;"></div>
        <label class="toggle"><input id="lowMode" type="checkbox"> <span><strong>Slow Wi‑Fi Mode</strong><br>Use this on weak hospital Wi‑Fi. It waits longer, retries more gently, and avoids giving up too quickly.</span></label>
        <div class="controls">
          <button id="retryBtn" class="btn secondary" type="button" style="display:none;">Retry</button>
          <button id="reloadBtn" class="btn secondary" type="button" style="display:none;">Reload Stream</button>
          <a id="openLink" class="openLink" href="#" target="_blank" rel="noopener" style="display:none;">Open Stream</a>
        </div>
      </div>
    </section>
    <section class="listPanel">
      <div id="grid" class="grid"></div>
      <div id="empty" class="empty" style="display:none;">No channels found.</div>
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
    const retryBtn = document.getElementById('retryBtn');
    const reloadBtn = document.getElementById('reloadBtn');
    const lowMode = document.getElementById('lowMode');
    const notice = document.getElementById('notice');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');

    let activeId = '';
    let activeChannel = null;
    let retryTimer = null;
    let retryCount = 0;
    let lastPlayUrl = '';
    const MAX_RETRIES = 8;

    count.textContent = channels.length;
    lowMode.checked = localStorage.getItem('thetvapp_low_wifi_mode') === '1';

    function setNotice(message, isWarning) {
      notice.textContent = message;
      notice.className = 'notice' + (isWarning ? ' warn' : '');
      notice.style.display = message ? 'block' : 'none';
    }

    function currentPlayUrl(channel, forceFresh) {
      if (!forceFresh && lastPlayUrl) return lastPlayUrl;
      const sep = channel.playUrl.indexOf('?') === -1 ? '?' : '&';
      lastPlayUrl = channel.playUrl + sep + 'fresh=' + Date.now();
      return lastPlayUrl;
    }

    function tryPlay() {
      const promise = video.play();
      if (promise && typeof promise.catch === 'function') {
        promise.catch(function () {
          setNotice('If the video did not start automatically, tap the video Play button or tap Retry.', true);
        });
      }
    }

    function clearRetry() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleReconnect(reason) {
      if (!activeChannel || retryCount >= MAX_RETRIES) {
        setNotice('The connection is still struggling. Tap Reload Stream, or try Open Stream in a new Safari tab.', true);
        return;
      }

      clearRetry();
      retryCount += 1;
      const slow = lowMode.checked;
      const baseDelay = slow ? 4500 : 2200;
      const delay = Math.min(baseDelay * retryCount, slow ? 18000 : 10000);
      setNotice('Slow Wi‑Fi detected: ' + reason + '. Reconnecting in about ' + Math.ceil(delay / 1000) + ' seconds. Attempt ' + retryCount + ' of ' + MAX_RETRIES + '.', true);
      retryTimer = setTimeout(function () {
        if (!activeChannel) return;
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.src = currentPlayUrl(activeChannel, true);
        video.load();
        tryPlay();
      }, delay);
    }

    function play(channel, forceFresh) {
      clearRetry();
      activeId = channel.id;
      activeChannel = channel;
      retryCount = 0;
      lastPlayUrl = '';
      video.preload = 'metadata';
      video.src = currentPlayUrl(channel, !!forceFresh);
      video.load();
      nowTitle.textContent = channel.name;
      nowText.textContent = lowMode.checked
        ? 'Slow Wi‑Fi Mode is on. Give the stream a little extra time to buffer before switching channels.'
        : 'If playback does not begin, tap Play in the video controls, Retry, or Open Stream.';
      openLink.href = channel.playUrl;
      openLink.style.display = 'inline-block';
      retryBtn.style.display = 'inline-block';
      reloadBtn.style.display = 'inline-block';
      setNotice('Loading stream. On weak Wi‑Fi, the first start can take 10–30 seconds.', false);
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setTimeout(tryPlay, lowMode.checked ? 1200 : 250);
    }

    function retryCurrent(forceFresh) {
      if (!activeChannel) return;
      clearRetry();
      retryCount = 0;
      setNotice(forceFresh ? 'Reloading a fresh stream link...' : 'Retrying playback...', false);
      video.pause();
      video.src = currentPlayUrl(activeChannel, !!forceFresh);
      video.load();
      setTimeout(tryPlay, lowMode.checked ? 1200 : 250);
    }

    video.addEventListener('playing', function () {
      clearRetry();
      retryCount = 0;
      setNotice('Playing. If the hospital Wi‑Fi drops, this page will try to reconnect automatically.', false);
    });

    video.addEventListener('waiting', function () { scheduleReconnect('buffering'); });
    video.addEventListener('stalled', function () { scheduleReconnect('stream stalled'); });
    video.addEventListener('suspend', function () {
      if (video.currentTime > 0 && !video.paused) scheduleReconnect('download paused');
    });
    video.addEventListener('abort', function () { scheduleReconnect('stream interrupted'); });
    video.addEventListener('error', function () { scheduleReconnect('video error'); });

    window.addEventListener('offline', function () {
      setNotice('This iPad appears to be offline. Reconnect to Wi‑Fi and the stream can be retried.', true);
    });
    window.addEventListener('online', function () {
      setNotice('Wi‑Fi is back. Retrying the current stream...', false);
      retryCurrent(true);
    });

    lowMode.addEventListener('change', function () {
      localStorage.setItem('thetvapp_low_wifi_mode', lowMode.checked ? '1' : '0');
      setNotice(lowMode.checked ? 'Slow Wi‑Fi Mode is on.' : 'Slow Wi‑Fi Mode is off.', false);
    });

    retryBtn.addEventListener('click', function () { retryCurrent(false); });
    reloadBtn.addEventListener('click', function () { retryCurrent(true); });

    function render() {
      const q = search.value.trim().toLowerCase();
      const visible = channels.filter(function (channel) { return channel.name.toLowerCase().includes(q); });
      grid.innerHTML = '';
      empty.style.display = visible.length ? 'none' : 'block';

      for (const channel of visible) {
        const button = document.createElement('button');
        button.className = 'channel' + (channel.id === activeId ? ' active' : '');
        button.type = 'button';
        button.onclick = function () { play(channel, true); };

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.alt = '';
        img.src = channel.poster || '';
        img.onerror = function () { img.style.display = 'none'; };

        const name = document.createElement('strong');
        name.textContent = channel.name;

        const genre = document.createElement('span');
        genre.textContent = (channel.genres && channel.genres[0]) || 'Live TV';

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

  const upstream = https.get(targetUrl, { headers: headers(), timeout: HTTP_TIMEOUT_MS }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
    });
    proxyRes.pipe(res);
  });

  upstream.setTimeout(HTTP_TIMEOUT_MS, () => {
    upstream.destroy(new Error('Segment request timed out'));
  });

  upstream.on('error', (error) => {
    if (!res.headersSent) return res.status(504).type('text/plain').send(error.message);
    res.destroy(error);
  });
});

loadChannels();

app.listen(PORT, '0.0.0.0', () => console.log(`Smart Proxy v1.2.1 live on ${PORT}`));

module.exports = app;
