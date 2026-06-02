'use strict';
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(cors());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.type('application/json');
  next();
});

// This function looks for channels.json in the main folder
function getChannels() {
  try {
    const p = path.join(__dirname, 'channels.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    console.error("JSON Error:", e.message);
  }
  return []; // Returns empty list instead of crashing
}

app.get('/manifest.json', (req, res) => {
  res.json({
    id: 'org.stremio.thetvapp',
    version: '1.0.2',
    name: 'TheTVApp',
    description: 'Watch live TV channels',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    catalogs: [{ type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' }],
    idPrefixes: ['thetvapp_']
  });
});

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const channels = getChannels();
  const metas = channels.map(c => ({
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

app.listen(PORT, () => console.log(`Live on ${PORT}`));
