'use strict';

const assert = require('assert');

const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:7000').replace(/\/$/, '');

const routes = [
  '/manifest.json',
  '/catalog/tv/thetvapp_channels.json',
  '/meta/tv/thetvapp_tlceast.json',
  '/stream/tv/thetvapp_tlceast.json',
  '/meta/movie/tt0068646.json',
  '/stream/movie/tt0068646.json'
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

(async () => {
  const manifest = await getJson('/manifest.json');
  assert.deepStrictEqual(manifest.resources, ['catalog', 'meta', 'stream'], 'manifest resources mismatch');
  assert(manifest.types.includes('tv'), 'manifest types missing tv');
  assert(manifest.types.includes('movie'), 'manifest types missing movie');
  assert(manifest.types.includes('series'), 'manifest types missing series');
  assert(manifest.catalogs.some((catalog) => catalog.type === 'tv' && catalog.id === 'thetvapp_channels'), 'missing live tv catalog');
  assert(manifest.catalogs.some((catalog) => catalog.type === 'movie' && catalog.id === 'torrentio_movies'), 'missing movie catalog');

  const catalog = await getJson('/catalog/tv/thetvapp_channels.json');
  assert(Array.isArray(catalog.metas), 'catalog.metas must be an array');

  const metaMovie = await getJson('/meta/movie/tt0068646.json');
  assert(metaMovie.meta && metaMovie.meta.id === 'tt0068646', 'meta route did not return movie metadata');

  const movieStream = await getJson('/stream/movie/tt0068646.json');
  assert(Array.isArray(movieStream.streams), 'movie stream route must return a streams array');
  assert(movieStream.streams.length > 0, 'Torrentio should return streams for The Godfather');

  const tlcStream = await getJson('/stream/tv/thetvapp_tlceast.json');
  assert(tlcStream.streams.length > 0, 'TLC stream route should contain a stream');

  console.log('\nAll required Stremio protocol routes (Live TV + Torrentio) returned JSON successfully.');
})().catch((err) => {
  console.error(`Verification failed: ${err.message}`);
  process.exit(1);
});
