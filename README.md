# yt-stream

> Written by AI, driven and reviewed by a human.

A self-hosted service that turns a YouTube live stream or video into an Icecast-compatible MP3 audio stream. One `GET` request with a YouTube URL starts the stream and redirects you to a mountpoint playable by any radio receiver, VLC, or browser.

The service manages exactly **one stream at a time** — starting a new YouTube URL replaces the current one.

Architecture, design decisions, and security rationale are documented in **[DESIGN.md](DESIGN.md)**.

## How it works

Four Docker containers behind a single public entry point:

- **Caddy** — reverse proxy and the only public door (ports 80/443). Routes `/api/*` to the stream service and `/stream` to Icecast; everything else returns 404. Handles automatic HTTPS.
- **stream** (Node.js) — the application. Validates the URL, runs the `streamlink → ffmpeg` pipeline, pushes MP3 audio to Icecast, watches listener counts.
- **Icecast** — the streaming server. Serves the audio on the `/stream` mountpoint to any number of listeners (capped by `ICECAST_MAX_LISTENERS`).
- **health** (Node.js) — an independent monitor on its own port (`HEALTH_PORT`) that probes Caddy, Icecast, and the stream service and reports a single verdict.

A separate `shared` package holds the configuration common to both Node services.

## Requirements

- Docker with Compose v2
- A **residential IP address** — see [Proxies](#proxies) below; without one YouTube will most likely block stream extraction

## Quickstart

```bash
cp .env.example .env
# edit .env: set a real API_KEY (and optionally PUBLIC_BASE_URL, ports)
docker compose up -d --build
```

Wait for the stack to come up, then check health:

```bash
curl http://localhost:8080/hc
# {"caddy":{"result":"ok",...},"icecast":{"result":"ok",...},"stream":{"result":"ok",...}}
```

Start a stream (default API key from `.env`):

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost/api/stream?url=https://www.youtube.com/watch?v=<id>"
# 302 Found — Location: /stream
```

Open `http://localhost/stream` in VLC, a browser, or any radio client.

Stop it manually:

```bash
curl -X DELETE -H "Authorization: Bearer $API_KEY" http://localhost/api/stream
```

The stream also stops on its own:

- **TTL** — after `STREAM_TTL_MINUTES` (default 15) with **zero listeners**; a stream nobody listens to winds down by itself
- **Pipeline failure** — if streamlink or ffmpeg dies (bad URL, YouTube block, proxy down)
- **Replacement** — starting a new URL replaces the current stream

## Proxies

YouTube aggressively blocks requests from datacenter/VPS IP ranges. If the service runs on a VPS (the typical case), stream extraction will almost certainly fail without a proxy:

- The host itself needs a **residential IP**, or the traffic must be routed through **residential proxies** — only residential IPs reliably pass YouTube's bot checks.
- Provide a list of proxy URLs in a `proxy.json` file at the repo root (JSON array of `http://`/`https://` URLs, credentials included inline):

  ```json
  [
    "http://user:pass@residential-proxy-1.example.com:8080",
    "https://user:pass@residential-proxy-2.example.com:3128"
  ]
  ```

  and point `PROXY_FILE` at it in `.env`:

  ```bash
  PROXY_FILE=/app/proxy.json
  ```

  The compose file already bind-mounts `./proxy.json` into the container at `/app/proxy.json`.
- streamlink picks a **random** entry from the list for each stream start; if the list is empty or `PROXY_FILE` is unset, it connects directly.

## API

All `/api/*` endpoints except `/api/state` require an API key: `Authorization: Bearer <key>` header, or `?key=<key>` query param when `ALLOW_KEY_IN_QUERY=true`.

| Method   | Path                                     | Auth | Purpose                                                            |
| -------- | ---------------------------------------- | ---- | ------------------------------------------------------------------ |
| `GET`    | `/api/stream?url=<youtube_url>`          | ✅   | Start a stream; `302` redirect to the audio mount                  |
| `DELETE` | `/api/stream`                            | ✅   | Stop the current stream                                            |
| `GET`    | `/api/state`                             | —    | Service status + health verdict (JSON); key-exempt by decision     |
| `GET`    | `/stream`                                | —    | Audio mount (Icecast, via Caddy) — play it in any client           |
| `GET`    | `/hc` (alias `/health`) on `HEALTH_PORT` | —    | Component health of caddy / icecast / stream; `503` if any is down |

Status codes for `GET /api/stream`: `302` success (redirect), `400` missing/invalid URL, `401` missing/invalid key, `429` another stream operation is in progress, `500` extraction/transcode/Icecast failure. `DELETE /api/stream` returns `200` (stopped), `404` (no active stream), or `429`.

A stream also stops automatically after `STREAM_TTL_MINUTES` (default 15) with zero listeners.

## Configuration

Everything is configured via environment variables (see `.env.example`):

| Variable                  | Default            | Description                                                                           |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`         | `http://localhost` | Public base URL — Caddy site address (`https://…` enables auto-HTTPS) and stream URLs |
| `HTTP_PORT`               | `80`               | Host port → Caddy HTTP                                                                |
| `HTTPS_PORT`              | `443`              | Host port → Caddy HTTPS                                                               |
| `HEALTH_PORT`             | `8080`             | Host port → health service                                                            |
| `API_KEY`                 | `dev-api-key`      | API key for `/api/*` (dev fallback logs a startup warning)                            |
| `ALLOW_KEY_IN_QUERY`      | `false`            | Allow `?key=` query auth (can leak into logs/history — keep off)                      |
| `ICECAST_SOURCE_PASSWORD` | `secret`           | Source auth (ffmpeg → Icecast)                                                        |
| `ICECAST_ADMIN_PASSWORD`  | `admin`            | Admin API auth (internal polling; also used by the health probe)                      |
| `ICECAST_MAX_LISTENERS`   | `2`                | Per-mount listener cap, enforced by Icecast alone                                     |
| `STREAM_TTL_MINUTES`      | `15`               | Auto-stop after N minutes with zero listeners                                         |
| `PROXY_FILE`              | _(empty)_          | Path to a JSON array of proxy URLs (inside the container: `/app/proxy.json`)          |
| `STREAMLINK_QUALITY`      | `audio_only,worst` | streamlink quality priority list                                                      |
| `LOG_LEVEL`               | `info`             | pino log level                                                                        |

Container-internal ports are fixed and not configurable — see [DESIGN.md](DESIGN.md).

## Development

npm-workspaces monorepo:

```
packages/
├── shared/   # yt-stream-shared — env Config used by both services
├── stream/   # the stream service
└── health/   # the health monitor
```

```bash
npm install
npm test          # node:test suites for all workspaces
npm run lint      # oxlint
npm run format    # oxfmt
```

Per-workspace variants: `npm run test:stream`, `npm run lint:health`, etc.

## License

MIT
