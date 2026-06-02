'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 7000);

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  catalogs: [{ type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' }],
  idPrefixes: ['thetvapp_']
};

function getChannels() {
  // FOOLPROOF: Checks both the root and the data folder
  const paths = [
    path.join(__dirname, 'channels.json'),
    path.join(__dirname, 'data', 'channels.json')
  ];
  
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  }
  return []; // Return empty if file is missing
}

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = getChannels().map(c => ({
    id: c.id, type: 'tv', name: c.name, poster: c.poster
  }));
  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const channel = getChannels().find(c => c.id === req.params.id);
  res.json({ meta: channel ? { ...channel, type: 'tv' } : null });
});

app.get('/stream/tv/:id.json', (req, res) => {
  const channel = getChannels().find(c => c.id === req.params.id);
  res.json({ streams: channel && channel.url ? [{ name: channel.name, title: 'Live TV', url: channel.url }] : [] });
});

app.listen(PORT, () => console.log(`Addon live on port ${PORT}`));
