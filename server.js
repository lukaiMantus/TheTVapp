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
  version: '1.1.6',
  name: 'TheTVApp (No-VPN)',
  description: 'Watch live TV channels without a VPN (Smart Proxy)',
  resources: ['catalog', 'meta', 'stream'],
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'thetvapp_channels', name: 'Live TV Channels' }],
  idPrefixes: ['thetvapp_']
};

const channelMap = {
  'thetvapp_tlceast': 'TLCEast',
  'thetvapp_tlc': 'TLC',
  'thetvapp_ae': 'AEEast',
  'thetvapp_amc': 'AMCEast'
};

app.get('/manifest.json', (req, res) => res.json(manifest));

app.get('/catalog/tv/thetvapp_channels.json', (req, res) => {
  const metas = Object.keys(channelMap).map(id => ({
    id: id,
    type: 'tv',
    name: id.replace('thetvapp_', '').toUpperCase().replace('EAST', ' Eastern'),
    poster: `https://thetvapp.to/img/channels/${id.replace('thetvapp_', '')}.png`
  }));
  res.json({ metas });
});

app.get('/meta/tv/:id.json', (req, res) => {
  const id = req.params.id;
  res.json({
    meta: {
      id: id,
      type: 'tv',
      name: id.replace('thetvapp_', '').toUpperCase().replace('EAST', ' Eastern'),
      poster: `https://thetvapp.to/img/channels/${id.replace('thetvapp_', '')}.png`
    }
  });
});

app.get('/stream/tv/:id.json', (req, res) => {
  const id = req.params.id;
  if (!channelMap[id]) return res.json({ streams: [] });
  const host = req.get('host');
  res.json({
    streams: [{
      name: 'Smart Relay',
      title: 'No VPN Required',
      url: `https://${host}/play/${id}/index.m3u8`
    }]
  });
});

function getFinalUrl(targetUrl) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://thetvapp.to/'
      }
    };
    https.get(targetUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(res.headers.location);
      } else {
        resolve(targetUrl);
      }
    }).on('error', reject);
  });
}

app.get('/play/:id/index.m3u8', async (req, res) => {
  const id = req.params.id;
  const channelId = channelMap[id];
  if (!channelId) return res.status(404).send('Not Found');

  try {
    const tvpassUrl = `https://tvpass.org/live/${channelId}/sd`;
    const realStreamUrl = await getFinalUrl(tvpassUrl);
    
    const options = {
      headers: {
        'Referer': 'https://thetvapp.to/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    };

    https.get(realStreamUrl, options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', (chunk) => { data += chunk; });
      proxyRes.on('end', () => {
        const host = req.get('host');
        const baseUrl = realStreamUrl.substring(0, realStreamUrl.lastIndexOf('/') + 1);
        const encodedBase = Buffer.from(baseUrl).toString('base64');
        
        const rewrittenData = data.replace(/([a-zA-Z0-9_-]+\.ts)/g, `https://${host}/segment/${encodedBase}/$1`);
        
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewrittenData);
      });
    }).on('error', (e) => res.status(500).send(e.message));

  } catch (error) {
    res.status(500).send('Discovery Failed');
  }
});

app.get('/segment/:base64/:file', (req, res) => {
  const baseUrl = Buffer.from(req.params.base64, 'base64').toString();
  const targetUrl = baseUrl + req.params.file;
  
  https.get(targetUrl, {
    headers: {
      'Referer': 'https://thetvapp.to/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  }).on('error', (e) => res.status(500).send(e.message));
});

app.listen(PORT, () => console.log(`Smart Proxy v1.1.6 live on ${PORT}`));
