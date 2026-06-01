'use strict';

const assert = require('assert');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');

const routes = [
  '/manifest.json',
  '/catalog/tv/thetvapp_channels.json',
  '/meta/tv/thetvapp_espn.json',
  '/stream/tv/thetvapp_espn.json',
  '/stream/tv/thetvapp_nasa_tv.json'
];

async function getJson(route) {
  const url = `${BASE_URL}${route}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const contentType = response.headers.get('content-type') || '';
  assert(response.ok, `${route} returned HTTP ${response.status}`);
  assert(contentType.includes('application/json'), `${route} returned non-JSON content type: ${contentType}`);
  const json = await response.json();
  console.log(`OK ${route}`);
  return json;
}

async function headOrGet(url) {
  let response;
  try {
    response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  } catch (_) {
    response = null;
  }
  if (!response || response.status >= 400) {
    response = await fetch(url, { method: 'GET', redirect: 'follow', headers: { range: 'bytes=0-1024' } });
  }
  return response;
}

(async () => {
  const manifest = await getJson('/manifest.json');
  assert.deepStrictEqual(manifest.resources, ['catalog', 'meta', 'stream'], 'manifest resources mismatch');
  assert.deepStrictEqual(manifest.types, ['tv'], 'manifest types mismatch');
  assert(manifest.catalogs.some((catalog) => catalog.type === 'tv' && catalog.id === 'thetvapp_channels'), 'missing expected catalog declaration');

  const catalog = await getJson('/catalog/tv/thetvapp_channels.json');
  assert(Array.isArray(catalog.metas), 'catalog.metas must be an array');
  assert(catalog.metas.some((meta) => meta.id === 'thetvapp_espn'), 'catalog missing thetvapp_espn');

  const meta = await getJson('/meta/tv/thetvapp_espn.json');
  assert(meta.meta && meta.meta.id === 'thetvapp_espn', 'meta route did not return ESPN metadata');

  const espnStream = await getJson('/stream/tv/thetvapp_espn.json');
  assert(Array.isArray(espnStream.streams), 'ESPN stream route must return a streams array');

  const playableStream = await getJson('/stream/tv/thetvapp_nasa_tv.json');
  assert(playableStream.streams.length > 0, 'NASA stream route should contain a playable stream');
  assert(playableStream.streams[0].url.endsWith('.m3u8'), 'playable stream should be an HLS .m3u8 URL');

  const streamResponse = await headOrGet(playableStream.streams[0].url);
  assert(streamResponse.status < 400, `HLS stream URL returned HTTP ${streamResponse.status}`);

  console.log('\nAll required Stremio protocol routes returned JSON successfully.');
  console.log('At least one lawful direct HLS stream URL was reachable.');
  if (!espnStream.streams.length) {
    console.log('ESPN route is protocol-correct but has no stream until an authorized ESPN HLS URL is configured.');
  }
})().catch((err) => {
  console.error(`Verification failed: ${err.message}`);
  process.exit(1);
});
