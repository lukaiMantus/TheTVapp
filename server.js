'use strict';
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.1.3',
  name: 'TheTVApp (No-VPN)',
  description: 'Watch live TV channels without a VPN (Smart Proxy)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' }],
  idPrefixes: ['thetvapp_']
};

let cachedChannels = [];
function loadChannels() {
  try {
    const paths = [
      path.join(__dirname, 'channels.json'),
      path.join(__dirname, 'data', 'channels.json'),
      '/opt/render/project/src/channels.json',
      '/opt/render/project/src/data/channels.json'
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) {
        cachedChannels = JSON.parse(fs.readFileSync(p, 'utf8'));
        return;
      }
    }
  } catch (e) {}
}
loadChannels();

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  if (cachedChannels.length === 0) loadChannels();
  const metas = cachedChannels.map(c => ({
    id: c.id, type: 'tv', name: c.name, poster: c.poster
  }));
  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  if (cachedChannels.length === 0) loadChannels();
  const channel = cachedChannels.find(c => c.id === req.params.id);
  res.json({ meta: channel ? { ...channel, type: 'tv' } : null });
});

app.get('/stream/tv/:id.json', (req, res) => {
  if (cachedChannels.length === 0) loadChannels();
  const channel = cachedChannels.find(c => c.id === req.params.id);
  if (!channel) return res.json({ streams: [] });
  const host = req.get('host');
  const proxyUrl = `https://${host}/proxy/${channel.id}/index.m3u8`;
  res.json({
    streams: [{
      name: 'Smart Relay (No VPN)',
      title: channel.name,
      url: proxyUrl
    }]
  });
});

app.get('/proxy/:id/index.m3u8', (req, res) => {
  if (cachedChannels.length === 0) loadChannels();
  const channel = cachedChannels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).send('Not Found');
  const options = {
    headers: {
      'Referer': 'https://thetvapp.to/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };
  https.get(channel.url, options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (chunk) => { data += chunk; });
    proxyRes.on('end', () => {
      const host = req.get('host');
      const baseUrl = `https://${host}/proxy/${req.params.id}/`;
      const rewrittenData = data.replace(/([a-zA-Z0-9_-]+\.ts)/g, `${baseUrl}$1`);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewrittenData);
    });
  }).on('error', (e) => res.status(500).send(e.message));
});

app.get('/proxy/:id/:segment.ts', (req, res) => {
  if (cachedChannels.length === 0) loadChannels();
  const channel = cachedChannels.find(c => c.id === req.params.id);
  if (!channel) return res.status(404).send('Not Found');
  const baseUrl = channel.url.substring(0, channel.url.lastIndexOf('/') + 1);
  const targetUrl = baseUrl + req.params.segment + '.ts';
  const options = {
    headers: {
      'Referer': 'https://thetvapp.to/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };
  https.get(targetUrl, options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  }).on('error', (e) => res.status(500).send(e.message));
});

app.listen(PORT, () => console.log(`Smart Proxy v1.1.3 live on ${PORT}`));
