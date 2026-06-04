'use strict';
const express = require('express'), cors = require('cors'), https = require('https'), http = require('http'), fs = require('fs'), path = require('path'), WebTorrent = require('webtorrent');
const app = express(), PORT = process.env.PORT || 7000, torrentClient = new WebTorrent();
app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp', version: '2.0.0', name: 'TheTVApp (Master Version)',
  description: 'Original Live TV + Torrentio Movies & Series',
  resources: ['catalog', 'meta', 'stream'], types: ['tv', 'movie', 'series'],
  catalogs: [
    { type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' },
    { type: 'movie', id: 'torrentio_movies', name: 'Movies', extra: [{ name: 'search' }] },
    { type: 'series', id: 'torrentio_series', name: 'Series', extra: [{ name: 'search' }] }
  ], idPrefixes: ['thetvapp_', 'tt']
};

let cachedChannels = [];
function loadChannels() {
  const paths = [path.join(__dirname, 'channels.json'), path.join(process.cwd(), 'channels.json')];
  for (const p of paths) { if (fs.existsSync(p)) { 
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(d)) return cachedChannels = d.map(c => ({ id: c.id, type: 'tv', name: c.name, poster: c.poster || c.logo, url: c.url }));
  }}
  return [];
}
function headers() { return { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://thetvapp.to/', 'Accept': '*/*' }; }
function httpsGetText(url) { return new Promise((res, rej) => { https.get(url, { headers: headers() }, (r) => {
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return res({ redirectedTo: r.headers.location });
  let b = ''; r.on('data', d => b += d); r.on('end', () => res({ body: b }));
}).on('error', rej); }); }
async function discoverStreamUrl(c) {
  const s = (c.url || '').match(/\/hls\/([^/]+)\//i)?.[1] || c.id.replace(/^thetvapp_/, '');
  const r = await httpsGetText(\`https://tvpass.org/live/\${encodeURIComponent(s)}/sd\`);
  return r.redirectedTo || \`https://tvpass.org/live/\${encodeURIComponent(s)}/sd\`;
}

app.get('/', (req, res) => res.redirect('/watch'));
app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/search/:type', async (req, res) => {
  try { const r = await new Promise(resolve => http.get(\`https://v3-cinemeta.strem.io/catalog/\${req.params.type}/top/search=\${encodeURIComponent(req.query.q || '')}.json\`, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
  })); res.json(r.metas || []); } catch (e) { res.json([]); }
});
app.get('/streams/:type/:id', async (req, res) => {
  try { const r = await new Promise(resolve => https.get(\`https://torrentio.strem.fun/stream/\${req.params.type}/\${req.params.id}.json\`, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
  })); res.json(r.streams || []); } catch (e) { res.json([]); }
});
app.get('/stream-torrent/:hash', (req, res) => {
  const t = torrentClient.get(req.params.hash) || torrentClient.add(req.params.hash, t => {
    const f = t.files.find(f => f.name.match(/\\.(mp4|mkv|avi)$/i));
    if (!f) return res.status(404).send('No video');
    const r = req.headers.range;
    if (!r) { res.writeHead(200, { 'Content-Length': f.length, 'Content-Type': 'video/mp4' }); f.createReadStream().pipe(res); }
    else {
      const p = r.replace(/bytes=/, "").split("-"), s = parseInt(p[0], 10), e = p[1] ? parseInt(p[1], 10) : f.length - 1;
      res.writeHead(206, { 'Content-Range': \`bytes \${s}-\${e}/\${f.length}\`, 'Accept-Ranges': 'bytes', 'Content-Length': (e - s) + 1, 'Content-Type': 'video/mp4' });
      f.createReadStream({ start: s, end: e }).pipe(res);
    }
  });
});
app.get('/play/:id/index.m3u8', async (req, res) => {
  const c = loadChannels().find(c => c.id === req.params.id);
  if (!c) return res.status(404).send('Not Found');
  try {
    const u = await discoverStreamUrl(c), p = await httpsGetText(u);
    const r = p.body.split(/\\r?\\n/).map(l => {
      if (!l.trim() || l.startsWith('#')) return l;
      const t = new URL(l.trim(), u).href;
      return \`\${req.protocol}://\${req.get('host')}/segment/\${Buffer.from(t).toString('base64url')}\`;
    }).join('\\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl').send(r);
  } catch (e) { res.status(500).send(e.message); }
});
app.get('/segment/:e', (req, res) => {
  https.get(Buffer.from(req.params.e, 'base64url').toString('utf8'), { headers: headers() }, (pr) => {
    res.writeHead(pr.statusCode || 200, { ...pr.headers, 'Access-Control-Allow-Origin': '*' }); pr.pipe(res);
  });
});
app.get('/img-proxy', (req, res) => {
  https.get(req.query.url, { headers: headers() }, (pr) => {
    res.writeHead(pr.statusCode || 200, { 'Content-Type': pr.headers['content-type'] }); pr.pipe(res);
  });
});
app.get('/watch', (req, res) => {
  const ch = JSON.stringify(loadChannels());
  res.send(\`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>TheTVApp</title><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><style>
  :root { --bg: #0f172a; --card: #1e293b; --accent: #22c55e; --text: #f8fafc; }
  body { margin: 0; font-family: sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 15px; background: #000; position: sticky; top: 0; z-index: 100; display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
  .tabs { display: flex; gap: 15px; } .tab { cursor: pointer; opacity: 0.6; padding: 5px; } .tab.active { border-bottom: 2px solid var(--accent); opacity: 1; }
  input { flex: 1; min-width: 200px; padding: 10px; border-radius: 8px; border: none; background: var(--card); color: #fff; }
  main { display: grid; grid-template-columns: 1fr 350px; gap: 20px; padding: 15px; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } .sidebar { order: -1; } }
  video { width: 100%; aspect-ratio: 16/9; background: #000; border-radius: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .card { background: var(--card); border-radius: 10px; overflow: hidden; cursor: pointer; border: none; color: inherit; padding: 0; text-align: left; }
  .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; } .card-info { padding: 8px; font-size: 12px; }
  .stream-item { padding: 10px; margin-top: 5px; background: #334155; border-radius: 6px; cursor: pointer; font-size: 12px; }
  </style></head><body><header><div class="tabs"><div class="tab active" onclick="setTab('live')">Live TV</div><div class="tab" onclick="setTab('movie')">Movies</div><div class="tab" onclick="setTab('series')">Series</div></div><input type="text" id="search" placeholder="Search..." oninput="handleSearch()"></header>
  <main><div id="grid" class="grid"></div><div class="sidebar"><video id="video" controls autoplay playsinline></video><h3 id="title">Select something</h3><div id="status" style="color:var(--accent);font-size:12px"></div><div id="streams" style="display:none;margin-top:15px"><h4>Streams</h4><div id="items"></div></div></div></main>
  <script>
    let currentTab = 'live', hls = null, searchTimeout; const channels = \${ch};
    function setTab(t) { currentTab = t; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.innerText.toLowerCase().includes(t))); handleSearch(); }
    async function handleSearch() {
      const q = document.getElementById('search').value.toLowerCase(); const g = document.getElementById('grid');
      if (currentTab === 'live') render(channels.filter(c => c.name.toLowerCase().includes(q)));
      else { g.innerHTML = 'Loading...'; clearTimeout(searchTimeout); searchTimeout = setTimeout(async () => {
        const r = await fetch(\`/search/\${currentTab}?q=\${q}\`); render(await r.json());
      }, 500); }
    }
    function render(items) {
      document.getElementById('grid').innerHTML = items.map(i => {
        const p = i.poster || 'https://via.placeholder.com/150x225?text=No+Poster';
        const src = p.includes('thetvapp.to') ? \`/img-proxy?url=\${encodeURIComponent(p)}\` : p;
        return \`<button class="card" onclick="select('\${i.id}', '\${i.type || currentTab}', '\${i.name.replace(/'/g, "\\\\'")}')"><img src="\${src}"><div class="card-info"><strong>\${i.name}</strong></div></button>\`;
      }).join('');
    }
    async function select(id, type, name) {
      document.getElementById('title').innerText = name; document.getElementById('streams').style.display = 'none';
      if (type === 'tv' || currentTab === 'live') play(\`\${window.location.origin}/play/\${id}/index.m3u8\`);
      else {
        document.getElementById('items').innerHTML = 'Searching...'; document.getElementById('streams').style.display = 'block';
        const r = await fetch(\`/streams/\${type}/\${id}\`), s = await r.json();
        document.getElementById('items').innerHTML = s.map(x => \`<div class="stream-item" onclick="play('\${x.infoHash ? window.location.origin + '/stream-torrent/' + x.infoHash : x.url}')">\${x.title}</div>\`).join('');
      }
    }
    function play(u) {
      const v = document.getElementById('video'), s = document.getElementById('status');
      s.innerText = u.includes('torrent') ? 'Connecting...' : 'Playing...'; if (hls) hls.destroy();
      if (u.endsWith('.m3u8')) {
        if (Hls.isSupported()) { hls = new Hls(); hls.loadSource(u); hls.attachMedia(v); hls.on(Hls.Events.MANIFEST_PARSED, () => v.play()); }
        else if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = u; v.play(); }
      } else { v.src = u; v.play().catch(e => s.innerText = 'Error playing.'); }
    }
    handleSearch();
  </script></body></html>\`);
});
app.listen(PORT, () => console.log(\`TheTVApp v2.0.0 live on \${PORT}\`));
