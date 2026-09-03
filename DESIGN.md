# YouTube → Radio Stream Service — Design (PoC)

> **Status: superseded.** The production refactor replaced this architecture (module decomposition, event bus, no state machine) — see [`docs/PRD-6-7.md`](docs/PRD-6-7.md) for the current design.

## Overview

A self-hosted Node.js service that converts a YouTube live stream or video into an Icecast-compatible MP3 audio stream. The user makes a single `GET` request with a YouTube URL and is redirected to an Icecast mountpoint playable by any radio receiver.

The PoC manages exactly **one stream at a time** — starting a new YouTube URL replaces the current one.

```
GET /stream?url=https://youtube.com/watch?v=...
       │
       ▼
  ┌───────────────────────────────────────────────────────┐
  │                    STREAM SERVICE (Node.js)           │
  │                                                       │
  │  ┌──────────┐    ┌───────────────┐    ┌────────────┐  │
  │  │ REST API │───▶│ Stream Manager│───▶│ streamlink │  │
  │  │(Fastify) │    │ (lifecycle)   │    │ ffmpeg     │  │
  │  └────┬─────┘    └───────────────┘    └─────┬──────┘  │
  │       │                                     │         │
  │       │  302 redirect                       ▼         │
  │       └──────────────────────────▶┌───────────────┐   │
  │                                   │    Icecast    │   │
  │                                   │   /stream     │   │
  │                                   │  audio/mpeg   │   │
  │                                   └───────────────┘   │
  └───────────────────────────────────────────────────────┘
       │
       ▼
  Plays on any radio receiver, VLC, hardware tuner, browser, etc.
```

---

## Components

### 1. REST API

Thin HTTP layer (Fastify).

**Route isolation** — only the four routes listed below are registered. No Icecast admin endpoints, mountpoints, or internal URLs are exposed through the API server. The Icecast port (8000) serves audio directly; the API server (8080) serves only the management interface.

| Method   | Path              | Params / Body                 | Response                                                                                     |
| -------- | ----------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `GET`    | `/stream?url=...` | `url` (query param, required) | `302` redirect to Icecast mountpoint on success; `500` if pipeline fails to start within 15s |
| `GET`    | `/stream`         | —                             | `200` — current stream status JSON (`idle` if nothing running)                               |
| `DELETE` | `/stream`         | —                             | `200` — stream stopped; `404` — no stream was running                                        |
| `GET`    | `/health`         | —                             | `200` — component statuses (ffmpeg, Icecast); `503` if degraded                              |

**Key behaviours:**

- **Single stream** — requesting a different URL kills the current pipeline (even if still starting) and begins a new one. No multi-stream support in PoC.
- **Synchronous** — `GET /stream?url=...` blocks until ffmpeg connects to Icecast (up to 15s timeout), then redirects. On failure, returns `500` immediately.
- **Idempotent** — requesting the same URL while streaming or starting returns `302` immediately without restarting the pipeline.
- **202 Accepted** while streamlink is opening the stream and ffmpeg is connecting; **302 Found** once audio is flowing to Icecast.
- **No authentication** — intended for trusted-network use in PoC.

### 2. Stream Manager

Manages the single stream's full lifecycle.

**State machine:**

```
                 ┌──────────┐
    GET /stream  │   IDLE   │
     w/ url ────▶│          │
                 └─────┬────┘
                       │
                       ▼
                 ┌──────────┐
                 │ STARTING │  streamlink opening, ffmpeg connecting
                 └────┬─────┘
                      │
              ┌───────┴────────┐
              ▼                ▼
        ┌──────────┐    ┌──────────┐
        │STREAMING │    │ STOPPED  │  streamlink/ffmpeg failure or 15s timeout
        └────┬─────┘    └──────────┘
             │               ▲
    DELETE   │               │
    /stream  │  0 listeners  │
       │     │  > TTL        │
       ▼     ▼               │
        ┌──────────┐         │
        │ STOPPED  │◀────────┘
        └──────────┘
         manual DELETE, TTL expiry, or pipeline failure
```

**Per-stream lifecycle:**

1. **Fetch & stream** — `streamlink` opens the YouTube live stream (its own HLS client, optionally through a proxy) and writes raw media to stdout.
2. **Transcode & stream** — `ffmpeg` reads streamlink's output from stdin, transcodes to MP3 (libmp3lame) at 128 kbps, and pushes to Icecast via the `icecast://` protocol. ffmpeg never touches YouTube directly.
3. **Health monitoring** — watches the pipeline (streamlink + ffmpeg); if either exits unexpectedly, transitions to `STOPPED`. Send another `GET /stream?url=...` to restart.
4. **Listener polling** — periodically queries Icecast's `/admin/listmounts` XML API to count listeners and verify the mountpoint is active (15s interval). When `listeners == 0` for `STREAM_TTL_MINUTES` (default 15 min), the pipeline is torn down and the state transitions to `STOPPED`.
5. **Metadata** — after the mountpoint becomes active, fetches the stream's title/author via YouTube oEmbed and pushes `<author> - <title>` to Icecast's `/admin/metadata` `updinfo` endpoint so clients display the live title. Best-effort: unavailable metadata never fails the stream.

**Pipeline command:**

```bash
streamlink --http-proxy <proxy> --default-stream audio_only,worst -o - \
  https://youtube.com/watch?v=VIDEO_ID \
  | ffmpeg -i - -c:a libmp3lame -b:a 128k -content_type audio/mpeg \
    -f mp3 icecast://source:${ICECAST_SOURCE_PASSWORD}@icecast:8000/stream
```

### 3. Icecast Server

Industry-standard streaming server (off-the-shelf, no custom code).

- **Single fixed mountpoint** — `/stream`. No dynamic mountpoint creation.
- **ICY protocol** — injects `icy-name`, `icy-genre`, `icy-br` headers so radio receivers display metadata correctly.
- **Dynamic metadata** — accepts `GET /admin/metadata?...&mode=updinfo&song=<title>` updates so the live title/author is shown; set by the stream service after start.
- **Admin API** — `GET /admin/listmounts` returns listener count and mountpoint status (polled by the Stream Manager every 15s).
- **Configuration** — minimal; source password, admin password, hostname, and bind port.

---

## Data Model

No persistent state. Streams start fresh on each request and on service restart. The only state is in-memory: current YouTube URL, stream state, listener count.

---

## YouTube-Specific Handling

| Concern                         | Approach                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| **Live & VOD**                  | streamlink handles both uniformly — same pipeline, no branching                        |
| **Best audio**                  | `--default-stream audio_only,worst` (audio-only when available, else 144p)             |
| **Format conversion**           | YouTube serves Opus/MP4-AAC; ffmpeg transcodes to MP3                                  |
| **Geo-restrictions / bot-wall** | Optional rotating proxy list (`proxy.json`) passed to streamlink `--http-proxy`        |
| **Rate limiting**               | streamlink's HLS client keeps up with YouTube's 30s live window (bare ffmpeg couldn't) |
| **Cookies (logged-in)**         | Not used — proxy list replaces cookie authentication                                   |

---

## Configuration

### Environment Variables

| Variable                  | Default            | Description                                                                                                                                  |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `8080`             | API server listen port                                                                                                                       |
| `ICECAST_HOST`            | `icecast`          | Icecast server hostname (Docker service name by default)                                                                                     |
| `ICECAST_PORT`            | `8000`             | Public facing port for redirect URLs (internal always 8000)                                                                                  |
| `ICECAST_SOURCE_PASSWORD` | `secret`           | Source password for ffmpeg → Icecast                                                                                                         |
| `ICECAST_ADMIN_PASSWORD`  | `admin`            | Admin password for polling Icecast API                                                                                                       |
| `PUBLIC_HOSTNAME`         | `localhost`        | Public hostname used in `302` redirect URLs                                                                                                  |
| `LOG_LEVEL`               | `info`             | Logging level: `debug`, `info`, `warn`, `error`                                                                                              |
| `PROXY_FILE`              | _(none)_           | Path to a user-provided proxy list (JSON array of proxy URL strings); only read when explicitly set — otherwise streamlink connects directly |
| `STREAMLINK_QUALITY`      | `audio_only,worst` | streamlink stream priority list (audio-only when available, else 144p)                                                                       |
| `STREAM_TTL_MINUTES`      | `15`               | Auto-stop stream after N minutes with zero listeners                                                                                         |

---

## Deployment (Docker Compose)

```yaml
name: yt-stream

services:
  icecast:
    image: moul/icecast@sha256:b35cd6367327335b51b989c277e6feaff7cd61d65846ec7fee361c6eb1cea620
    platform: linux/amd64
    ports:
      - "${ICECAST_PORT:-8871}:8000"
    volumes:
      - ./icecast.xml:/icecast.xml:ro
    environment:
      ICECAST_SOURCE_PASSWORD: "${ICECAST_SOURCE_PASSWORD:-secret}"
      ICECAST_ADMIN_PASSWORD: "${ICECAST_ADMIN_PASSWORD:-admin}"
      ICECAST_HOSTNAME: "${ICECAST_HOSTNAME:-localhost}"
    # Copy our config into the writable location first — the image entrypoint
    # uses sed -i which cannot rename over a Docker bind-mounted file.
    command: sh -c "cp /icecast.xml /etc/icecast2/icecast.xml && exec /start.sh"
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: "256M"

  stream-service:
    build: .
    image: yt-stream:latest
    ports:
      - "${PORT:-8870}:8080"
    volumes:
      - stream-data:/app/data
      - ./proxy.json:/app/proxy.json:ro # user-provided proxy list for streamlink
    environment:
      PORT: "8080"
      ICECAST_HOST: icecast
      ICECAST_SOURCE_PASSWORD: "${ICECAST_SOURCE_PASSWORD:-secret}"
      ICECAST_ADMIN_PASSWORD: "${ICECAST_ADMIN_PASSWORD:-admin}"
      ICECAST_PORT: "${ICECAST_PORT:-8871}" # public port for redirect URLs only
      PUBLIC_HOSTNAME: "${PUBLIC_HOSTNAME:-localhost}"
      DATA_DIR: /app/data
      LOG_LEVEL: "${LOG_LEVEL:-info}"
      STREAM_TTL_MINUTES: "${STREAM_TTL_MINUTES:-15}"
      PROXY_FILE: "${PROXY_FILE:-}"
      STREAMLINK_QUALITY: "${STREAMLINK_QUALITY:-audio_only,worst}"
    restart: unless-stopped
    depends_on:
      - icecast
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: "256M" # streamlink + ffmpeg + node

volumes:
  stream-data:
```

---

## Directory Structure

```
yt-stream/
├── src/
│   ├── index.js            # Entry point, Fastify app setup, routes
│   ├── stream-manager.js   # Core logic: lifecycle, streamlink→ffmpeg pipeline, TTL   *(removed by the refactor)*
│   ├── proxy-list.js       # Reads proxy.json and returns the proxy list             *(now Config)*
│   ├── icecast-client.js   # Icecast admin API polling (listeners, mountpoint status) *(now icecast.js)*
│   └── health.js           # Health check logic (component status aggregation)       *(now healthMonitor.js)*
├── proxy.json              # User-provided proxy list (JSON array of URL strings)
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## Logging

JSON structured logs to stdout via [pino](https://github.com/pinojs/pino) (Fastify's default logger):

```json
{"level":"info","ts":"2025-01-01T12:00:00.000Z","msg":"stream started","youtube_url":"https://...","pid":12345}
{"level":"warn","ts":"2025-01-01T12:05:00.000Z","msg":"ffmpeg exited unexpectedly","code":1}
{"level":"error","ts":"2025-01-01T12:05:01.000Z","msg":"retry 3/10 failed","error":"Icecast connection refused"}
```

---

## Tech Stack

| Layer          | Choice                     | Rationale                                         |
| -------------- | -------------------------- | ------------------------------------------------- |
| API server     | Node.js ≥ 24 LTS (Fastify) | Async I/O, fast HTTP layer, bundled pino logging  |
| Stream extract | streamlink                 | Robust HLS client that keeps up with YouTube live |
| Transcoder     | ffmpeg                     | Universal, widely available                       |
| Stream server  | Icecast 2.4                | Battle-tested, ICY metadata, fan-out              |
| Logging        | pino (Fastify default)     | Fastest JSON logger, zero-config with Fastify     |
| Container      | Docker + Compose           | Images pinned by digest, one-command deploy       |

---

## Alternative: Liquidsoap Variant

> **Deferred** — not in PoC scope.

For **radio-grade** reliability (silence detection, automatic failover, jingle/hook injection), `streamlink + ffmpeg` could be replaced with Liquidsoap:

```liquidsoap
s = input.ytdl("https://youtube.com/watch?v=...")
s = mksafe(s)
output.icecast(%mp3(bitrate=128), mount="/stream",
  host="localhost", port=8000, password="secret", s)
```

The API would generate Liquidsoap configs and control them via Liquidsoap's telnet server — more complex to orchestrate but rock-solid for 24/7 operation.

---

## Future Enhancements

- **Multi-stream support** — manage multiple concurrent YouTube → Icecast pipelines
- **Multiple bitrates / formats** — MP3 + AAC + Ogg at configurable quality levels
- **Web UI** — simple dashboard showing active streams, listener counts, waveforms
- **Stream scheduling** — start/stop streams at predetermined times
- **Relay mode** — act as a repeater for an existing Icecast stream
- **Recording** — archive streams to disk for time-shifted listening
