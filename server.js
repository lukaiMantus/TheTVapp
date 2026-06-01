'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 7000);
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors({ origin: '*', methods: ['GET', 'HEAD', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept', 'Range', 'User-Agent'] }));
app.options('*', cors());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Range, User-Agent');
  res.type('application/json');
  next();
});

const manifest = {
  id: 'org.stremio.thetvapp',
  version: '1.0.2',
  name: 'TheTVApp',
  description: 'Watch live TV channels',
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

function loadChannels() {
  const channelsPath = path.join(__dirname, 'data', 'channels.json');
  const raw = fs.readFileSync(channelsPath, 'utf8');
  const channels = JSON.parse(raw);

  // Optional authorized runtime stream overrides. Example:
  // STREAM_OVERRIDES='{"thetvapp_espn":"https://your-authorized-stream/espn.m3u8"}' npm start
  let overrides = {};
  if (process.env.STREAM_OVERRIDES) {
    try {
      overrides = JSON.parse(process.env.STREAM_OVERRIDES);
    } catch (err) {
      console.error('STREAM_OVERRIDES must be valid JSON:', err.message);
    }
  }

  return channels.map((channel) => {
    const overrideUrl = overrides[channel.id] || process.env[`STREAM_URL_${channel.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    return overrideUrl ? { ...channel, url: overrideUrl } : channel;
  });
}

function getChannels() {
  return loadChannels().filter((channel) => channel && channel.id && channel.type === 'tv' && channel.name);
}

function findChannel(id) {
  return getChannels().find((channel) => channel.id === id) || null;
}

function toMetaPreview(channel) {
  return {
    id: channel.id,
    type: 'tv',
    name: channel.name,
    poster: channel.poster,
    logo: channel.logo || channel.poster,
    description: channel.description || `${channel.name} live TV channel`,
    genres: channel.genres || ['Live TV']
  };
}

function toMetaDetail(channel) {
  return {
    ...toMetaPreview(channel),
    background: channel.background || channel.poster,
    runtime: 'Live',
    videos: [
      {
        id: channel.id,
        title: 'Live TV'
      }
    ]
  };
}

function jsonOk(res, payload) {
  res.status(200).type('application/json; charset=utf-8').json(payload);
}

function jsonNotFound(res, message) {
  res.status(404).type('application/json; charset=utf-8').json({ error: message || 'Not found' });
}

app.get('/', (req, res) => {
  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  jsonOk(res, {
    name: manifest.name,
    description: manifest.description,
    manifest: `${origin}/manifest.json`,
    requiredRoutes: [
      `${origin}/manifest.json`,
      `${origin}/catalog/tv/thetvapp_channels.json`,
      `${origin}/meta/tv/thetvapp_espn.json`,
      `${origin}/stream/tv/thetvapp_espn.json`
    ]
  });
});

app.get('/manifest.json', (req, res) => {
  jsonOk(res, manifest);
});

app.get('/catalog/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv' || id !== 'thetvapp_channels') {
    return jsonNotFound(res, 'Catalog not found');
  }

  const metas = getChannels().map(toMetaPreview);
  return jsonOk(res, { metas });
});

app.get('/meta/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv' || !id.startsWith('thetvapp_')) {
    return jsonNotFound(res, 'Meta not found');
  }

  const channel = findChannel(id);
  if (!channel) {
    return jsonOk(res, { meta: null });
  }

  return jsonOk(res, { meta: toMetaDetail(channel) });
});

app.get('/stream/:type/:id.json', (req, res) => {
  const { type, id } = req.params;
  if (type !== 'tv' || !id.startsWith('thetvapp_')) {
    return jsonNotFound(res, 'Stream not found');
  }

  const channel = findChannel(id);
  if (!channel) {
    return jsonOk(res, { streams: [] });
  }

  if (!channel.url) {
    return jsonOk(res, {
      streams: [],
      warning: `${channel.name} has no configured authorized direct HLS stream URL. Set STREAM_OVERRIDES or STREAM_URL_${channel.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')} with a lawful directly playable .m3u8 URL.`
    });
  }

  return jsonOk(res, {
    streams: [
      {
        name: channel.name,
        title: 'Live TV',
        url: channel.url,
        behaviorHints: {
          notWebReady: false
        }
      }
    ]
  });
});

app.get('*', (req, res) => {
  jsonNotFound(res, 'Route not found. Stremio API routes must end with .json.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${manifest.name} Stremio addon listening on port ${PORT}`);
  console.log(`Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`Catalog:  http://localhost:${PORT}/catalog/tv/thetvapp_channels.json`);
  console.log(`Stream:   http://localhost:${PORT}/stream/tv/thetvapp_espn.json`);
});
