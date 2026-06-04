'use strict';
const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebTorrent = require('webtorrent');

const app = express();
const PORT = process.env.PORT || 7000;
const torrentClient = new WebTorrent();

app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.6.0',
  name: 'TheTVApp (No-VPN + Torrent Streaming)',
  description: 'Watch live TV and movies directly in your browser',
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

function headers() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://thetvapp.to/',
    'Accept': '*/*'
  };
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: headers() }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve({ redirectedTo: res.headers.location, body: '' });
      }
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ body }));
    }).on('error', reject);
  });
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

async function discoverStreamUrl(channel) {
  const streamName = (channel.url || '').match(/\/hls\/([^/]+)\//i)?.[1] || channel.id.replace(/^thetvapp_/, '');
  const tvpassUrl = `https://tvpass.org/live/${encodeURIComponent(streamName)}/sd`;
  const first = await httpsGetText(tvpassUrl);
  return first.redirectedTo || tvpassUrl;
}

app.get('/', (req, res) => res.redirect('/watch'));
app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/search/:type', async (req, res) => {
  const query = req.query.q || '';
  try {
    const url = `https://v3-cinemeta.strem.io/catalog/${req.params.type}/top/${query ? 'search=' + encodeURIComponent(query) : ''}.json`;
    const data = await httpGetJson(url);
    res.json(data.metas || []);
  } catch (e) { res.json([]); }
});

app.get('/streams/:type/:id', async (req, res) => {
  try {
    const url = `https://torrentio.strem.fun/stream/${req.params.type}/${req.params.id}.json`;
    const data = await httpGetJson(url);
    res.json(data.streams || []);
  } catch (e) { res.json([]); }
});

app.get('/stream-torrent/:infoHash', (req, res) => {
  const torrent = torrentClient.get(req.params.infoHash);
  const handle = (t) => {
    const file = t.files.find(f => f.name.endsWith('.mp4') || f.name.endsWith('.mkv') || f.name.endsWith('.avi'));
    if (!file) return res.status(404).send('No video file');
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Length': file.length, 'Content-Type': 'video/mp4' });
      file.createReadStream().pipe(res);
    } else {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': (end - start) + 1, 'Content-Type': 'video/mp4' });
      file.createReadStream({ start, end }).pipe(res);
    }
  };
  if (torrent) handle(torrent); else torrentClient.add(req.params.infoHash, handle);
});

app.get('/play/:id/index.m3u8', async (req, res) => {
  const channel = loadChannels().find(c => c.id === req.params.id);
  if (!channel) return res.status(404).send('Not Found');
  try {
    const realUrl = await discoverStreamUrl(channel);
    const playlist = await httpsGetText(realUrl);
    const rewritten = playlist.body.split(/\r?\n/).map(line => {
      if (!line.trim() || line.startsWith('#')) return line;
      const target = new URL(line.trim(), realUrl).href;
      return `${req.protocol}://${req.get('host')}/segment/${Buffer.from(target).toString('base64url')}`;
    }).join('\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl').send(rewritten);
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/segment/:encoded', (req, res) => {
  https.get(Buffer.from(req.params.encoded, 'base64url').toString('utf8'), { headers: headers() }, (pRes) => {
    res.writeHead(pRes.statusCode || 200, { ...pRes.headers, 'Access-Control-Allow-Origin': '*' });
    pRes.pipe(res);
  });
});

app.get('/watch', (req, res) => {
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
        @media (max-width: 800px) { main { grid-template-columns: 1fr; } .sidebar { order: -1; } }
        .player-container { background: #000; border-radius: 12px; overflow: hidden; position: sticky; top: 120px; }
        video { width: 100%; aspect-ratio: 16/9; background: #000; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 15px; }
        .card { background: var(--card); border-radius: 8px; overflow: hidden; cursor: pointer; transition: transform 0.2s; text-align: left; border: none; width: 100%; color: inherit; padding: 0; }
        .card:hover { transform: scale(1.05); }
        .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; background: #000; }
        .card-info { padding: 10px; font-size: 14px; }
        .stream-list { padding: 15px; background: var(--card); border-radius: 12px; margin-top: 20px; }
        .stream-item { padding: 10px; margin-bottom: 8px; background: #334155; border-radius: 6px; cursor: pointer; font-size: 13px; }
        .stream-item:hover { background: #475569; }
        .status { font-size: 12px; color: var(--accent); margin-top: 5px; }
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
                    <div id="video-status" class="status"></div>
                </div>
            </div>
            <div id="streams" class="stream-list" style="display:none">
                <h4>Select Quality</h4>
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
            if (currentTab === 'live') {
                renderGrid(channels.filter(c => c.name.toLowerCase().includes(query)));
            } else {
                grid.innerHTML = 'Loading...';
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(async () => {
                    const res = await fetch(\`/search/\${currentTab}?q=\${query}\`);
                    renderGrid(await res.json());
                }, 500);
            }
        }
        function renderGrid(items) {
            const grid = document.getElementById('grid');
            grid.innerHTML = items.map(item => \`
                <button class="card" onclick="selectItem('\${item.id}', '\${item.type || currentTab}', '\${item.name.replace(/'/g, "\\\\'")}')">
                    <img src="\${item.poster || 'https://via.placeholder.com/150x225?text=No+Poster'}" onerror="this.src='https://via.placeholder.com/150x225?text=No+Poster'">
                    <div class="card-info"><strong>\${item.name}</strong></div>
                </button>
            \`).join('');
        }
        async function selectItem(id, type, name) {
            document.getElementById('playing-title').innerText = name;
            document.getElementById('streams').style.display = 'none';
            document.getElementById('video-status').innerText = '';
            if (type === 'tv' || currentTab === 'live') {
                playStream(\`\${window.location.origin}/play/\${id}/index.m3u8\`);
            } else {
                document.getElementById('stream-items').innerHTML = 'Searching streams...';
                document.getElementById('streams').style.display = 'block';
                const res = await fetch(\`/streams/\${type}/\${id}\`);
                const streams = await res.json();
                document.getElementById('stream-items').innerHTML = streams.map(s => \`
                    <div class="stream-item" onclick="playStream('\${s.infoHash ? window.location.origin + '/stream-torrent/' + s.infoHash : s.url}')">
                        \${s.title}
                    </div>
                \`).join('');
            }
        }
        function playStream(url) {
            const video = document.getElementById('video');
            const status = document.getElementById('video-status');
            status.innerText = url.includes('stream-torrent') ? 'Connecting to peers...' : 'Playing...';
            video.src = url;
            video.play().catch(e => { status.innerText = 'Playback error. Try another stream.'; });
        }
        handleSearch();
    </script>
</body>
</html>`);
});

app.listen(PORT, () => console.log(`TheTVApp v1.6.0 live on ${PORT}`));
