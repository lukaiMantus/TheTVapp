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
  version: '1.0.5',
  name: 'TheTVApp',
  description: 'Watch live TV channels with full HLS proxy support',
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

// Manifest
app.get('/manifest.json', (req, res) => {
  res.json(manifest);
});

// Catalog
app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = getChannels().map(c => ({
    id: c.id,
    type: 'tv',
    name: c.name,
    poster: c.poster || ''
  }));

  res.json({ metas });
});

// Meta
app.get('/meta/tv/:id.json', (req, res) => {
  const channel = getChannels().find(c => c.id === req.params.id);

  res.json({
    meta: channel
      ? {
          id: channel.id,
          type: 'tv',
          name: channel.name,
          poster: channel.poster || ''
        }
      : null
  });
});

// Stream
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
        name: channel.name,
        title: 'Live TV',
        url: proxyUrl
      }
    ]
  });
});

// Main playlist proxy
app.get('/proxy/:id/index.m3u8', (req, res) => {
  const channel = getChannels().find
