'use strict';
const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.1.7',
  name: 'TheTVApp (No-VPN)',
  description: 'Watch live TV channels without a VPN (Smart Proxy)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' }],
  idPrefixes: ['thetvapp_']
};

const channels = {
  'thetvapp_tlceast': { streamName: 'TLCEast', name: 'TLC USA Eastern', poster: 'https://thetvapp.to/img/channels/tlceast.png' },
  'thetvapp_tlc': { streamName: 'TLC', name: 'TLC USA', poster: 'https://thetvapp.to/img/channels/tlc.png' },
  'thetvapp_ae': { streamName: 'AEEast', name: 'A&E Eastern', poster: 'https://thetvapp.to/img/channels/ae.png' },
  'thetvapp_amc': { streamName: 'AMCEast', name: 'AMC Eastern', poster: 'https://thetvapp.to/img/channels/amc.png' }
};

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
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body }));
    }).on('error', reject);
  });
}

async function discoverStreamUrl(streamName) {
  const tvpassUrl = `https://tvpass.org/live/${streamName}/sd`;
  const first = await httpsGetText(tvpassUrl);
  return first.redirectedTo || tvpassUrl;
}

function encodeUrl(targetUrl) {
  return Buffer.from(targetUrl).toString('base64url');
}

function decodeUrl(encoded) {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function proxiedUrl(req, targetUrl) {
  return `https://${req.get('host')}/segment/${encodeUrl(targetUrl)}`;
}

app.get('/', (req, res) => {
  res.json({ name: manifest.name, version: manifest.version, manifest: `https://${req.get('host')}/manifest.json` });
});

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = Object.entries(channels).map(([id, channel]) => ({
    id,
    type: 'tv',
    name: channel.name,
    poster: channel.poster,
    logo: channel.poster,
    description: `${channel.name} live TV channel`,
    genres: ['Live TV']
  }));
  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const channel = channels[req.params.id];
  if (!channel) return res.json({ meta: null });
  res.json({
    meta: {
      id: req.params.id,
      type: 'tv',
      name: channel.name,
      poster: channel.poster,
      logo: channel.poster,
      background: channel.poster,
      description: `${channel.name} live TV channel`,
      genres: ['Live TV'],
      runtime: 'Live',
      videos: [{ id: req.params.id, title: 'Live TV' }]
    }
  });
});

app.get('/stream/tv/:id.json', (req, res) => {
  const channel = channels[req.params.id];
  if (!channel) return res.json({ streams: [] });
  res.json({
    streams: [{
      name: 'Smart Relay',
      title: channel.name,
      url: `https://${req.get('host')}/play/${req.params.id}/index.m3u8`,
      behaviorHints: { notWebReady: false }
    }]
  });
});

app.get('/play/:id/index.m3u8', async (req, res) => {
  const channel = channels[req.params.id];
  if (!channel) return res.status(404).send('Not Found');

  try {
    const realStreamUrl = await discoverStreamUrl(channel.streamName);
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

app.listen(PORT, '0.0.0.0', () => console.log(`Smart Proxy v1.1.7 live on ${PORT}`));
