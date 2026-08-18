# YouTube → Radio Stream Service — Design (PoC)

## Overview

A self-hosted Node.js service that converts a YouTube live stream or video into an
Icecast-compatible MP3 audio stream. The user makes a single `GET` request with a
YouTube URL and is redirected to an Icecast mountpoint playable by any radio receiver.

The PoC manages exactly **one stream at a time** — starting a new YouTube URL replaces
the current one.

```
GET /stream?url=https://youtube.com/watch?v=...
       │
       ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    STREAM SERVICE (Node.js)                  │
  │                                                              │
  │  ┌──────────┐    ┌───────────────┐    ┌──────────┐          │
  │  │ REST API │───▶│ Stream Manager│───▶│ yt-dlp + │          │
  │  │(Fastify) │    │ (lifecycle)   │    │ ffmpeg   │          │
  │  └────┬─────┘    └───────────────┘    └─────┬────┘          │
  │       │                                     │               │
  │       │  302 redirect                       ▼               │
  │       └──────────────────────────▶┌───────────────┐         │
  │                                   │    Icecast    │         │
  │                                   │   /stream     │         │
  │                                   │  audio/mpeg   │         │
  │                                   └───────────────┘         │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  Plays on any radio receiver, VLC, hardware tuner, browser, etc.
```

---

## Components

### 1. REST API

Thin HTTP layer (Fastify).

**Route isolation** — only the four routes listed below are registered. No Icecast
admin endpoints, mountpoints, or internal URLs are exposed through the API server.
The Icecast port (8000) serves audio directly; the API server (8080) serves only
the management interface.

| Method   | Path                 | Params / Body                          | Response                                                                                     |
| -------- | -------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET`    | `/stream?url=...`    | `url` (query param, required)          | `302` redirect to Icecast mountpoint on success; `500` if pipeline fails to start within 15s |
| `GET`    | `/stream`            | —                                      | `200` — current stream status JSON (`idle` if nothing running)                               |
| `DELETE` | `/stream`            | —                                      | `200` — stream stopped; `404` — no stream was running                                        |
| `GET`    | `/health`            | —                                      | `200` — component statuses (ffmpeg, Icecast); `503` if degraded                              |

**Key behaviours:**

- **Single stream** — requesting a different URL kills the current pipeline (even if
  still starting) and begins a new one. No multi-stream support in PoC.
- **Synchronous** — `GET /stream?url=...` blocks until ffmpeg connects to Icecast
  (up to 15s timeout), then redirects. On failure, returns `500` immediately.
- **Idempotent** — requesting the same URL while streaming or starting returns
  `302` immediately without restarting the pipeline.
- **202 Accepted** while yt-dlp is extracting and ffmpeg is connecting; **302 Found**
  once audio is flowing to Icecast.
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
                 │ STARTING │  yt-dlp extracting, ffmpeg connecting
                 └────┬─────┘
                      │
              ┌───────┴────────┐
              ▼                ▼
        ┌──────────┐    ┌──────────┐
        │STREAMING │    │ STOPPED  │  yt-dlp/ffmpeg failure or 15s timeout
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

1. **Extract audio URL** — `yt-dlp -f bestaudio --get-url <youtube_url>` extracts the
   highest-quality audio-only stream URL from YouTube.
2. **Transcode & stream** — `ffmpeg` reads from the extracted URL, transcodes to MP3
   (libmp3lame) at 128 kbps, and pushes to Icecast via the `icecast://` protocol.
3. **Health monitoring** — watches the ffmpeg process; if it exits unexpectedly,
   transitions to `STOPPED`. Send another `GET /stream?url=...` to restart.
4. **Listener polling** — periodically queries Icecast's `/admin/listmounts` XML API to
   count listeners and verify the mountpoint is active (15s interval). When
   `listeners == 0` for `STREAM_TTL_MINUTES` (default 15 min), the pipeline is torn
   down and the state transitions to `STOPPED`.

**Pipeline command:**

```bash
ffmpeg -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -i "$(yt-dlp -f bestaudio --get-url "https://youtube.com/watch?v=VIDEO_ID")" \
  -c:a libmp3lame -b:a 128k -content_type audio/mpeg \
  -f mp3 icecast://source:${ICECAST_SOURCE_PASSWORD}@icecast:8000/stream
```

### 3. Icecast Server

Industry-standard streaming server (off-the-shelf, no custom code).

- **Single fixed mountpoint** — `/stream`. No dynamic mountpoint creation.
- **ICY protocol** — injects `icy-name`, `icy-genre`, `icy-br` headers so radio
  receivers display metadata correctly.
- **Admin API** — `GET /admin/listmounts` returns listener count and mountpoint status
  (polled by the Stream Manager every 15s).
- **Configuration** — minimal; source password, admin password, hostname, and bind port.

---

## Data Model

No persistent state. Streams start fresh on each request and on service restart.
The only state is in-memory: current YouTube URL, stream state, listener count.

---

## YouTube-Specific Handling

| Concern                 | Approach                                                     |
| ----------------------- | ------------------------------------------------------------ |
| **Live & VOD**          | yt-dlp handles both uniformly — same pipeline, no branching  |
| **Best audio**          | `-f bestaudio` picks the highest-bitrate audio-only stream   |
| **Format conversion**   | YouTube serves Opus/MP4-AAC; ffmpeg transcodes to MP3        |
| **URL expiry**          | Extracted stream URLs live ~6 hours; auto-re-extract on 403  |
| **Geo-restrictions**    | yt-dlp `--proxy` flag, configurable via `YTDLP_PROXY` env var|
| **Rate limiting**       | yt-dlp has built-in rate limiting; jittered reconnect        |
| **Cookies (logged-in)** | Mount `cookies.txt` into the container for restricted videos |

---

## Configuration

### Environment Variables

| Variable                  | Default     | Description                                              |
|---------------------------|-------------|----------------------------------------------------------|
| `PORT`                    | `8080`      | API server listen port                                   |
| `ICECAST_HOST`            | `icecast`   | Icecast server hostname (Docker service name by default) |
| `ICECAST_PORT`            | `8000`      | Public facing port for redirect URLs (internal always 8000) |
| `ICECAST_SOURCE_PASSWORD` | `secret`    | Source password for ffmpeg → Icecast                     |
| `ICECAST_ADMIN_PASSWORD`  | `admin`     | Admin password for polling Icecast API                   |
| `PUBLIC_HOSTNAME`         | `localhost` | Public hostname used in `302` redirect URLs              |
| `LOG_LEVEL`               | `info`      | Logging level: `debug`, `info`, `warn`, `error`          |
| `YTDLP_PROXY`             | _(none)_    | Proxy URL for yt-dlp (`--proxy` flag)                    |
| `STREAM_TTL_MINUTES`      | `15`        | Auto-stop stream after N minutes with zero listeners     |
| `COOKIES_PATH`            | _(none)_    | Path to cookies file for yt-dlp (`--cookies` flag)       |

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
      - ./cookies.txt:/app/cookies.txt   # writable — yt-dlp refreshes cookies in place
    environment:
      PORT: "8080"
      ICECAST_HOST: icecast
      ICECAST_SOURCE_PASSWORD: "${ICECAST_SOURCE_PASSWORD:-secret}"
      ICECAST_ADMIN_PASSWORD: "${ICECAST_ADMIN_PASSWORD:-admin}"
      ICECAST_PORT: "${ICECAST_PORT:-8871}"  # public port for redirect URLs only
      PUBLIC_HOSTNAME: "${PUBLIC_HOSTNAME:-localhost}"
      DATA_DIR: /app/data
      LOG_LEVEL: "${LOG_LEVEL:-info}"
      STREAM_TTL_MINUTES: "${STREAM_TTL_MINUTES:-15}"
      YTDLP_PROXY: "${YTDLP_PROXY:-}"
      COOKIES_PATH: /app/cookies.txt
    restart: unless-stopped
    depends_on:
      - icecast
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: "1G"   # yt-dlp JS challenge solver needs ~170MB on top of app

volumes:
  stream-data:
```

---

## Directory Structure

```
yt-stream/
├── src/
│   ├── index.js            # Entry point, Fastify app setup, routes
│   ├── stream-manager.js   # Core logic: lifecycle, pipeline, retries, state persistence
│   ├── icecast-client.js   # Icecast admin API polling (listeners, mountpoint status)
│   └── health.js           # Health check logic (component status aggregation)
├── data/                   # Mounted volume for state persistence
│   └── stream-state.json
├── cookies.txt             # Optional YouTube cookies for restricted videos
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## Logging

JSON structured logs to stdout via [pino](https://github.com/pinojs/pino)
(Fastify's default logger):

```json
{"level":"info","ts":"2025-01-01T12:00:00.000Z","msg":"stream started","youtube_url":"https://...","pid":12345}
{"level":"warn","ts":"2025-01-01T12:05:00.000Z","msg":"ffmpeg exited unexpectedly","code":1}
{"level":"error","ts":"2025-01-01T12:05:01.000Z","msg":"retry 3/10 failed","error":"Icecast connection refused"}
```

---

## Tech Stack

| Layer           | Choice      | Rationale                                   |
| ----------------| ----------- | ------------------------------------------- |
| API server      | Node.js ≥ 24 LTS (Fastify) | Async I/O, fast HTTP layer, bundled pino logging |
| Stream extract  | yt-dlp      | Only tool that reliably handles YouTube     |
| Transcoder      | ffmpeg      | Universal, widely available                 |
| Stream server   | Icecast 2.4 | Battle-tested, ICY metadata, fan-out        |
| Logging         | pino (Fastify default) | Fastest JSON logger, zero-config with Fastify |
| Container       | Docker + Compose | Images pinned by digest, one-command deploy  |

---

## Alternative: Liquidsoap Variant

> **Deferred** — not in PoC scope.

For **radio-grade** reliability (silence detection, automatic failover, jingle/hook
injection), `yt-dlp + ffmpeg` could be replaced with Liquidsoap:

```liquidsoap
s = input.ytdl("https://youtube.com/watch?v=...")
s = mksafe(s)
output.icecast(%mp3(bitrate=128), mount="/stream",
  host="localhost", port=8000, password="secret", s)
```

The API would generate Liquidsoap configs and control them via Liquidsoap's telnet
server — more complex to orchestrate but rock-solid for 24/7 operation.

---

## Future Enhancements

- **Multi-stream support** — manage multiple concurrent YouTube → Icecast pipelines
- **Multiple bitrates / formats** — MP3 + AAC + Ogg at configurable quality levels
- **Web UI** — simple dashboard showing active streams, listener counts, waveforms
- **Stream scheduling** — start/stop streams at predetermined times
- **Metadata passthrough** — forward YouTube title/artist as ICY `StreamTitle`
- **Relay mode** — act as a repeater for an existing Icecast stream
- **Recording** — archive streams to disk for time-shifted listening
