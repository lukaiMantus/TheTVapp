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
  version: '1.0.6',
  name: 'TheTVApp',
  description: 'Live TV Addon',
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
    const file = path.join(__dirname, 'channels.json');

    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file));
    }
  } catch (e) {
    console.log(e);
  }

  return [];
}

app.get('/manifest.json', function(req, res) {
  res.json(manifest);
});

app.get('/catalog/tv/thetvapp_channels.json', function(req, res) {
  const metas = getChannels().map(function(c) {
    return {
      id: c.id,
      type: 'tv',
      name: c.name,
      poster: c.poster || ''
    };
  });

  res.json({ metas: metas });
});

app.get('/meta/tv/:id.json', function(req, res) {
  const channel = getChannels().find(function(c) {
    return c.id === req.params.id;
  });

  if (!channel) {
    return res.json({ meta: null });
  }

  res.json({
    meta: {
      id: channel.id,
      type: 'tv',
      name: channel.name,
      poster: channel.poster || ''
    }
  });
});

app.get('/stream/tv/:id.json', function(req, res) {
  const channel = getChannels().find(function(c) {
    return c.id === req.params.id;
  });

  if (!channel || !channel.url) {
    return res.json({ streams: [] });
  }

  const proxy =
    req.protocol +
    '://' +
    req.get('host') +
    '/proxy/' +
    channel.id;

  res.json({
    streams: [
      {
        name: channel.name,
        title: 'Live TV',
        url: proxy
      }
    ]
  });
});

app.get('/proxy/:id', function(req, res) {
  const channel = getChannels().find(function(c) {
    return c.id === req.params.id;
  });

  if (!channel || !channel.url) {
    return res.status(404).send('Channel not found');
  }

  const options = {
    headers: {
      Referer: 'https://thetvapp.to/',
      Origin: 'https://thetvapp.to',
      'User-Agent': 'Mozilla/5.0'
    }
  };

  https.get(channel.url, options, function(proxyRes) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  }).on('error', function(e) {
    console.log(e);
    res.status(500).send(e.message);
  });
});

app.listen(PORT, function() {
  console.log('Addon running on port ' + PORT);
});
