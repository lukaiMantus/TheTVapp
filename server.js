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
  version: '1.2.0',
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
  if (!cachedChannels.length) 
app.get('/api/youtube/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);
  
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    const html = response.data;
    const jsonStr = html.split('var ytInitialData = ')[1]?.split(';</script>')[0];
    
    if (!jsonStr) return res.json([]);

    const data = JSON.parse(jsonStr);
    const results = [];
    const contents = data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer.contents;
    
    for (const item of contents) {
      if (item.videoRenderer) {
        const v = item.videoRenderer;
        results.push({
          id: v.videoId,
          title: v.title.runs[0].text,
          thumbnail: v.thumbnail.thumbnails[0].url,
          author: v.ownerText.runs[0].text
        });
      }
      if (results.length >= 10) break;
    }
    
    res.json(results);
  } catch (error) {
    console.error('YouTube Search Error:', error.message);
    res.status(500).json([]);
  }
});
loadChannels();
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

  const channelData = JSON.stringify(channels).replace(/</g, '\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="TheTVApp">
  <title>TheTVApp Web Player</title>
  <style>
    :root { color-scheme: dark; --bg: #070b14; --panel: #101827; --panel2: #162033; --text: #f8fafc; --muted: #9ca3af; --accent: #22c5e; --border: #263246; --yt: #ff0000; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(circle at top, #16233b 0%, var(--bg) 48%, #03050a 100%); color: var(--text); min-height: 100vh; }
    header { position: sticky; top: 0; z-index: 10; backdrop-filter: blur(18px); background: rgba(7, 11, 20, 0.88); border-bottom: 1px solid var(--border); padding: 14px 16px; }
    h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.2; }
    .topline { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .status { color: var(--muted); font-size: 13px; }
    
    .tabs { display: flex; gap: 8px; margin-top: 12px; }
    .tab { flex: 1; padding: 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--panel); color: var(--muted); font-weight: 600; cursor: pointer; text-align: center; transition: all 0.2s; }
    .tab.active { background: var(--panel2); color: var(--text); border-color: var(--accent); }
    .tab.active.yt-tab { border-color: var(--yt); }

    .search-container { margin-top: 12px; position: relative; }
    .search { width: 100%; padding: 13px 14px; border-radius: 14px; border: 1px solid var(--border); background: #0d1422; color: var(--text); font-size: 16px; outline: none; }
    
    main { display: grid; grid-template-columns: 390px minmax(0, 1fr); gap: 16px; padding: 16px; max-width: 1320px; margin: 0 auto; }
    .playerPanel, .listPanel { background: rgba(16, 24, 39, 0.92); border: 1px solid var(--border); border-radius: 18px; overflow: hidden; box-shadow: 0 20px 50px rgba(0,0,0,.28); }
    .playerPanel { position: sticky; top: 150px; align-self: start; }
    
    .video-wrapper { position: relative; width: 100%; padding-top: 56.25%; background: #000; }
    video, iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
    
    .now { padding: 14px; }
    .now h2 { margin: 0 0 6px; font-size: 18px; }
    .now p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; }
    .openLink { display: inline-block; margin-top: 12px; padding: 11px 13px; border-radius: 12px; color: #052e16; background: var(--accent); font-weight: 700; text-decoration: none; }
    
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 12px; }
    .channel, .yt-item { appearance: none; border: 1px solid var(--border); background: linear-gradient(180deg, var(--panel2), #0d1422); color: var(--text); border-radius: 16px; padding: 12px; min-height: 102px; text-align: left; display: flex; flex-direction: column; gap: 8px; cursor: pointer; }
    .channel:active, .channel.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(34,197,94,.22); }
    .yt-item:active, .yt-item.active { border-color: var(--yt); box-shadow: 0 0 0 2px rgba(255,0,0,.22); }
    
    .channel img, .yt-item img { width: 54px; height: 36px; object-fit: contain; background: rgba(255,255,255,.05); border-radius: 8px; }
    .yt-item img { width: 100%; height: auto; aspect-ratio: 16/9; object-fit: cover; }
    
    .channel strong, .yt-item strong { font-size: 14px; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .channel span, .yt-item span { color: var(--muted); font-size: 12px; }
    
    .empty, .loading { padding: 24px; color: var(--muted); text-align: center; }
    
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
      <div id="tab-tv" class="tab active" onclick="setTab('tv')">Live TV</div>
      <div id="tab-yt" class="tab" onclick="setTab('yt')">YouTube</div>
    </div>
    <div class="search-container">
      <input id="search" class="search" type="search" placeholder="Search channels..." autocomplete="off">
    </div>
  </header>
  <main>
    <section class="playerPanel">
      <div class="video-wrapper">
        <video id="video" controls playsinline webkit-playsinline style="display:block;"></video>
        <iframe id="yt-player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen style="display:none;"></iframe>
      </div>
      <div class="now">
        <h2 id="nowTitle">Pick something</h2>
        <p id="nowText">Tap any item below to start watching.</p>
        <a id="openLink" class="openLink" href="#" target="_blank" rel="noopener" style="display:none;">Open Stream</a>
      </div>
    </section>
    <section class="listPanel">
      <div id="grid" class="grid"></div>
      <div id="loading" class="loading" style="display:none;">Searching YouTube...</div>
      <div id="empty" class="empty" style="display:none;">Nothing found.</div>
    </section>
  </main>
  <script>
    const channels = ${channelData};
    let currentTab = 'tv';
    let ytResults = [];
    let activeId = '';
    
    const grid = document.getElementById('grid');
    const search = document.getElementById('search');
    const video = document.getElementById('video');
    const ytPlayer = document.getElementById('yt-player');
    const nowTitle = document.getElementById('nowTitle');
    const nowText = document.getElementById('nowText');
    const openLink = document.getElementById('openLink');
    const count = document.getElementById('count');
    const empty = document.getElementById('empty');
    const loading = document.getElementById('loading');

    function setTab(tab) {
      currentTab = tab;
      document.getElementById('tab-tv').className = 'tab' + (tab === 'tv' ? ' active' : '');
      document.getElementById('tab-yt').className = 'tab' + (tab === 'yt' ? ' active yt-tab' : '');
      search.placeholder = tab === 'tv' ? 'Search channels...' : 'Search YouTube...';
      search.value = '';
      render();
    }

    function playTV(channel) {
      activeId = channel.id;
      ytPlayer.style.display = 'none';
      ytPlayer.src = '';
      video.style.display = 'block';
      video.src = channel.playUrl;
      video.load();
      video.play().catch(() => {});
      
      nowTitle.textContent = channel.name;
      nowText.textContent = 'Live TV Stream';
      openLink.href = channel.playUrl;
      openLink.style.display = 'inline-block';
      render();
      if (window.innerWidth <= 820) window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function playYT(item) {
      activeId = item.id;
      video.pause();
      video.style.display = 'none';
      video.src = '';
      
      ytPlayer.style.display = 'block';
      ytPlayer.src = 'https://www.youtube.com/embed/' + item.id + '?autoplay=1';
      
      nowTitle.textContent = item.title;
      nowText.textContent = 'YouTube Video by ' + item.author;
      openLink.style.display = 'none';
      render();
      if (window.innerWidth <= 820) window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    async function searchYT(q) {
      if (!q) {
        ytResults = [];
        render();
        return;
      }
      loading.style.display = 'block';
      grid.innerHTML = '';
      try {
        const res = await fetch('/api/youtube/search?q=' + encodeURIComponent(q));
        ytResults = await res.json();
      } catch (e) {
        console.error(e);
        ytResults = [];
      }
      loading.style.display = 'none';
      render();
    }

    let searchTimeout;
    search.addEventListener('input', () => {
      if (currentTab === 'tv') {
        render();
      } else {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => searchYT(search.value.trim()), 500);
      }
    });

    function render() {
      grid.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      
      if (currentTab === 'tv') {
        const visible = channels.filter(c => c.name.toLowerCase().includes(q));
        count.textContent = visible.length;
        empty.style.display = visible.length ? 'none' : 'block';
        
        visible.forEach(channel => {
          const btn = document.createElement('button');
          btn.className = 'channel' + (channel.id === activeId ? ' active' : '');
          btn.onclick = () => playTV(channel);
          
          const img = document.createElement('img');
          img.src = channel.poster;
          img.onerror = () => img.style.display = 'none';
          
          const title = document.createElement('strong');
          title.textContent = channel.name;
          
          btn.append(img, title);
          grid.appendChild(btn);
        });
      } else {
        count.textContent = ytResults.length;
        empty.style.display = (ytResults.length || loading.style.display === 'block') ? 'none' : 'block';
        
        ytResults.forEach(item => {
          const btn = document.createElement('button');
          btn.className = 'yt-item' + (item.id === activeId ? ' active' : '');
          btn.onclick = () => playYT(item);
          
          const img = document.createElement('img');
          img.src = item.thumbnail;
          
          const title = document.createElement('strong');
          title.textContent = item.title;
          
          const author = document.createElement('span');
          author.textContent = item.author;
          
          btn.append(img, title, author);
          grid.appendChild(btn);
        });
      }
    }

    render();
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.send(renderWatchPage(req));
});

app.get('/manifest.json', (req, res) => {
  manifest.id = `org.stremio.thetvapp.${req.get('host').replace(/[^a-zA-Z0-9]/g, '')}`;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.json(manifest);
});

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

  https.get(targetUrl, { headers: headers() }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, {
      ...proxyRes.headers,
      'Access-Control-Allow-Origin': '*'
    });
    proxyRes.pipe(res);
  }).on('error', (error) => res.status(500).send(error.message));
});

loadChannels();

app.listen(PORT, '0.0.0.0', () => console.log(`Smart Proxy v1.2.0 live on ${PORT}`));

module.exports = app;
