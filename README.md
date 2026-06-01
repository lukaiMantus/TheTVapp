# TheTVApp Stremio Addon Backend

This project is a **fully working Stremio addon backend** implemented with Node.js and Express. It fixes the route problem where `/catalog/tv/thetvapp_channels.json` returned `404` by implementing every required Stremio addon protocol endpoint as a `.json` route.

## Working routes

The backend exposes the following required routes, all returning `application/json` with CORS enabled:

| Route | Purpose | Status |
|---|---:|---:|
| `/manifest.json` | Stremio addon manifest | Implemented |
| `/catalog/tv/thetvapp_channels.json` | Live TV catalog | Implemented |
| `/meta/tv/{id}.json` | Per-channel metadata | Implemented |
| `/stream/tv/{id}.json` | Per-channel streams | Implemented |

## Manifest

The manifest matches the requested addon identity and catalog declaration:

```json
{
  "id": "org.stremio.thetvapp",
  "version": "1.0.2",
  "name": "TheTVApp",
  "description": "Watch live TV channels",
  "resources": ["catalog", "meta", "stream"],
  "types": ["tv"],
  "catalogs": [
    {
      "type": "tv",
      "id": "thetvapp_channels",
      "name": "Live TV Channels"
    }
  ],
  "idPrefixes": ["thetvapp_"]
}
```

## Run locally

```bash
npm install
npm start
```

The default port is `7000`. You can override it with `PORT`.

## Verify routes

```bash
npm run test:routes
```

The verifier checks that the required routes return HTTP `200`, use `application/json`, include the required Stremio response shapes, and that at least one configured direct HLS `.m3u8` stream is reachable.

## Configure authorized stream URLs

The backend includes protocol-correct metadata for `thetvapp_espn`, but it does not ship an ESPN stream URL. ESPN is a licensed pay-TV channel, so you must configure a lawful, authorized, directly playable `.m3u8` URL before that specific channel can play.

You can configure it either with a single environment variable:

```bash
STREAM_URL_THETVAPP_ESPN="https://your-authorized-espn-stream.example/playlist.m3u8" npm start
```

Or with JSON overrides:

```bash
STREAM_OVERRIDES='{"thetvapp_espn":"https://your-authorized-espn-stream.example/playlist.m3u8"}' npm start
```

Once configured, `/stream/tv/thetvapp_espn.json` will return:

```json
{
  "streams": [
    {
      "name": "ESPN",
      "title": "Live TV",
      "url": "https://your-authorized-espn-stream.example/playlist.m3u8"
    }
  ]
}
```

## Public HTTPS test URL from this session

The temporary HTTPS endpoint exposed for this session is:

```text
https://7000-ih43x5p3116ldeozrjosk-5195ea4b.us2.manus.computer/manifest.json
```

The temporary endpoint is suitable for browser testing and Stremio installation during this session, but it is not a permanent production deployment.
