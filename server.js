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

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.4.0',
  name: 'TheTVApp (No-VPN + Torrentio)',
  description: 'Watch live TV and on-demand movies/series via Torrentio',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv', 'movie', 'series'],
  catalogs: [
    { type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' },
    { type: 'movie', id: 'torrentio_movies', name: 'Popular Movies', extra: [{ name: 'search' }] },
    { type: 'series', id: 'torrentio_series', name: 'Popular Series', extra: [{ name: 'search' }] }
  ],
  idPrefixes: ['thetvapp_', 'tt']
};

let cachedChannels = [];

function loadChannels() {
  const paths = [path.join(__dirname, 'channels.json'), path.join(process.cwd(), 'channels.json')];
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(parsed)) {
          cachedChannels = parsed.map(c => ({
            id: c.id, type: 'tv', name: c.name, poster: c.poster || c.logo, url: c.url, genres: ['Live TV']
          }));
          return cachedChannels;
        }
      }
    } catch (e) {}
  }
  return [];
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Redirect root to /watch
app.get('/', (req, res) => res.redirect('/watch'));

app.get('/manifest.json', (req, res) => res.json(manifest));

// Search Endpoint for Web Player
app.get('/search/:type', async (req, res) => {
  const { type } = req.params;
  const query = req.query.q;
  try {
    const url = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
    const data = await httpGetJson(url);
    res.json(data.metas || []);
  } catch (e) { res.json([]); }
});

// Stream Endpoint for Web Player
app.get('/streams/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  try {
    const url = `https://torrentio.strem.fun/stream/${type}/${id}.json`;
    const data = await httpGetJson(url);
    res.json(data.streams || []);
  } catch (e) { res.json([]); }
});

app.get('/watch', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const channels = JSON.stringify(loadChannels());
  
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TheTVApp Web Player</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --accent: #22c55e; --text: #f8fafc; }
        body { margin: 0; font-family: sans-serif; background: var(--bg); color: var(--text); }
        header { padding: 20px; background: #000; position: sticky; top: 0; z-index: 100; }
        .tabs { display: flex; gap: 20px; margin-bottom: 15px; }
        .tab { cursor: pointer; padding: 10px; border-bottom: 2px solid transparent; opacity: 0.6; }
        .tab.active { border-color: var(--accent); opacity: 1; }
        input { width: 100%; padding: 12px; border-radius: 8px; border: none; background: var(--card); color: #fff; box-sizing: border-box; }
        main { display: grid; grid-template-columns: 1fr 350px; gap: 20px; padding: 20px; }
        @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
        .player-container { background: #000; border-radius: 12px; overflow: hidden; position: sticky; top: 120px; }
        video { width: 100%; aspect-ratio: 16/9; background: #000; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 15px; }
        .card { background: var(--card); border-radius: 8px; overflow: hidden; cursor: pointer; transition: transform 0.2s; }
        .card:hover { transform: scale(1.05); }
        .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; }
        .card-info { padding: 10px; font-size: 14px; }
        .stream-list { padding: 15px; background: var(--card); border-radius: 12px; }
        .stream-item { padding: 10px; margin-bottom: 8px; background: #334155; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .stream-item:hover { background: #475569; }
    </style>
</head>
<body>
    <header>
        <div class="tabs">
            <div class="tab active" onclick="setTab('live')">Live TV</div>
            <div class="tab" onclick="setTab('movie')">Movies</div>
            <div class="tab" onclick="setTab('series')">Series</div>
        </div>
        <input type="text" id="search" placeholder="Search..." oninput="handleSearch()">
    </header>
    <main>
        <div class="content">
            <div id="grid" class="grid"></div>
        </div>
        <div class="sidebar">
            <div class="player-container">
                <video id="video" controls autoplay></video>
                <div style="padding:15px">
                    <h3 id="playing-title">Select something to watch</h3>
                    <p id="playing-desc"></p>
                </div>
            </div>
            <div id="streams" class="stream-list" style="display:none">
                <h4>Available Streams</h4>
                <div id="stream-items"></div>
            </div>
        </div>
    </main>

    <script>
        const channels = ${channels};
        let currentTab = 'live';
        let searchTimeout;

        function setTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById('search').value = '';
            handleSearch();
        }

        async function handleSearch() {
            const query = document.getElementById('search').value.toLowerCase();
            const grid = document.getElementById('grid');
            grid.innerHTML = 'Loading...';

            if (currentTab === 'live') {
                const filtered = channels.filter(c => c.name.toLowerCase().includes(query));
                renderGrid(filtered);
            } else {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(async () => {
                    const res = await fetch(\`/search/\${currentTab}?q=\${query}\`);
                    const data = await res.json();
                    renderGrid(data);
                }, 500);
            }
        }

        function renderGrid(items) {
            const grid = document.getElementById('grid');
            grid.innerHTML = items.map(item => \`
                <div class="card" onclick="selectItem('\${item.id}', '\${item.type}', '\${item.name.replace(/'/g, "\\\\'")}')">
                    <img src="\${item.poster || 'https://via.placeholder.com/150x225?text=No+Poster'}" alt="\${item.name}">
                    <div class="card-info">
                        <strong>\${item.name}</strong>
                    </div>
                </div>
            \`).join('');
        }

        async function selectItem(id, type, name) {
            document.getElementById('playing-title').innerText = name;
            document.getElementById('streams').style.display = 'none';
            
            if (type === 'tv') {
                const channel = channels.find(c => c.id === id);
                playStream(\`\${window.location.origin}/play/\${id}/index.m3u8\`);
            } else {
                document.getElementById('stream-items').innerHTML = 'Fetching streams...';
                document.getElementById('streams').style.display = 'block';
                const res = await fetch(\`/streams/\${type}/\${id}\`);
                const streams = await res.json();
                
                document.getElementById('stream-items').innerHTML = streams.map(s => \`
                    <div class="stream-item" onclick="playStream('\${s.url || s.externalUrl}')">
                        \${s.title}
                    </div>
                \`).join('');
            }
        }

        function playStream(url) {
            const video = document.getElementById('video');
            if (url.startsWith('magnet') || url.includes('infoHash')) {
                alert('This is a torrent link. For the best experience, use this addon directly in the Stremio App!');
                return;
            }
            video.src = url;
            video.play();
        }

        handleSearch();
    </script>
</body>
</html>`);
});

// Proxy and Live TV logic (Keep existing)
app.get('/play/:id/index.m3u8', async (req, res) => {
  const channel = cachedChannels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).send('Not Found');
  res.redirect(channel.url); // Simplified for this fix
});

app.listen(PORT, () => console.log(`TheTVApp v1.4.0 live on ${PORT}`));
