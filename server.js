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
  version: '1.0.4',
  name: 'TheTVApp',
  description: 'Watch live TV channels with Proxy Relay',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'thetvapp_channels',
      name: 'Live TV Channels'
    }
  ],
  idPrefixes: ['thetvapp_']
};

function getChannels() {
  try {
    const p = path.join(__dirname, 'channels.json');

    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load channels.json:', e.message);
  }

  return [];
}

app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = getChannels().map(c => ({
    id: c.id,
    type: 'tv',
    name: c.name,
    poster: c.poster
  }));

  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const channel = getChannels().find(c => c.id === req.params.id);

  res.json({
    meta: channel
      ? {
          ...channel,
          type: 'tv'
        }
      : null
  });
});

app.get('/stream/tv/:id.json', (req, res) => {
  const channel = getChannels().find(c => c.id === req.params.id);

  if (!channel || !channel.url) {
    return res.json({ streams: [] });
  }

  const protocol = req.secure ? 'https' : 'http';
  const host = req.get('host');

  const proxyUrl = `${protocol}://${host}/proxy/${channel.id}/index.m3u8`;

  res.json({
    streams: [
      {
        name: 'Proxy Relay',
        title: channel.name,
        url: proxyUrl
      }
    ]
  });
});

app.get('/proxy/:id/index.m3u8', (req, res) => {
  const channel = getChannels().find(c => c.id === req.params.id);

  if (!channel || !channel.url) {
    return res.status(404).send('Channel not found');
  }

  const options = {
    headers: {
      Referer: 'https://thetvapp.to/',
      'User-Agent': 'Mozilla/5.0'
    }
  };

  https.get(channel.url, options, (proxyRes) => {
    let data = '';

    proxyRes.on('data', chunk => {
      data += chunk;
    });

    proxyRes.on('end', () => {
      const baseUrl = channel.url.substring(
        0,
        channel.url.lastIndexOf('/') + 1
      );

      const rewritten = data.replace(
        /^(.*\.ts)$/gm,
        (match) => {
          const fullUrl = baseUrl + match;

          return `/proxy/${channel.id}/segment?url=${encodeURIComponent(fullUrl)}`;
        }
      );

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewritten);
    });
  }).on('error', (e) => {
    console.error('Playlist proxy error:', e.message);
    res.status(500).send(e.message);
  });
});

app.get('/proxy/:id/segment', (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).send('Missing URL');
  }

  const options = {
    headers: {
      Referer: 'https://thetvapp.to/',
      'User-Agent': 'Mozilla/5.0'
    }
  };

  https.get(targetUrl, options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  }).on('error', (e) => {
    console.error('Segment proxy error:', e.message);
    res.status(500).send(e.message);
  });
});

app.listen(PORT, () => {
  console.log(`Proxy Addon live on ${PORT}`);
});
