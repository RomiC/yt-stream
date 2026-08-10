# YouTube → Radio Stream Service — PoC Requirements

## Overview

A self-hosted Node.js service that converts a YouTube live stream or video into an
Icecast-compatible MP3 audio stream. The user makes a single `GET` request with a
YouTube URL and is redirected to an Icecast mountpoint playable by any radio receiver.

The PoC manages exactly **one stream at a time** — starting a new YouTube URL
replaces the current one.

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
  │                                   │  /stream      │         │
  │                                   │  audio/mpeg   │         │
  │                                   └───────────────┘         │
  └──────────────────────────────────────────────────────────────┘
       │
       ▼
  Plays on any radio receiver, VLC, hardware tuner, browser, etc.
```

---

## API Specification

### `GET /stream?url=<youtube_url>`

Start streaming a YouTube URL and redirect to the Icecast mountpoint.

| Parameter | Required | Description                                                            |
| --------- | -------- | ---------------------------------------------------------------------- |
| `url`     | Yes      | Full YouTube URL (`https://youtube.com/watch?v=...` or `youtu.be/...`) |

**Behavior by current state:**

| Current State | Same URL as running? | Action                                                                |
| ------------- | -------------------- | --------------------------------------------------------------------- |
| `idle`        | —                    | Start pipeline, return `302` once streaming (or `202` while starting) |
| `streaming`   | Yes                  | Return `302` immediately (idempotent, no restart)                     |
| `streaming`   | No                   | Stop current pipeline, start new one, return `302`                    |
| `starting`    | Yes                  | Return `202 Accepted` — pipeline still initializing                   |
| `starting`    | No                   | Kill in-progress startup, start new one, return `202`                 |
| `error`       | —                    | Same as `idle` — attempt fresh start, return `302`                    |
| `stopped`     | —                    | Same as `idle` — clear the stopped state and restart                  |

**Responses:**

- **`302 Found`** — pipeline is streaming. `Location` header points to:

  ```
  http://${PUBLIC_HOSTNAME}:${ICECAST_PORT}/stream
  ```

  Body is JSON:

  ```json
  {
    "state": "streaming",
    "stream_url": "http://host:8000/stream",
    "youtube_url": "https://youtube.com/watch?v=...",
    "listeners": 3
  }
  ```

- **`202 Accepted`** — pipeline is still starting (yt-dlp extracting, ffmpeg connecting).
  Body is JSON:

  ```json
  {
    "state": "starting",
    "youtube_url": "https://youtube.com/watch?v=..."
  }
  ```

- **`400 Bad Request`** — missing or invalid `url` parameter.

- **`500 Internal Server Error`** — pipeline failed to start (yt-dlp error, Icecast
  unreachable, etc.).

---

### `GET /stream`

Return the current stream status **without** starting or stopping anything.

**Responses:**

- **`200 OK`** — stream exists:

  ```json
  {
    "state": "streaming",
    "stream_url": "http://host:8000/stream",
    "youtube_url": "https://youtube.com/watch?v=...",
    "listeners": 3,
    "uptime_seconds": 1842,
    "idle_seconds": 0,
    "bitrate": 128
  }
  ```

- **`200 OK`** — no active stream:
  ```json
  {
    "state": "idle"
  }
  ```

---

### `DELETE /stream`

Stop the current stream immediately. Kills the ffmpeg process, disconnects from
Icecast, and transitions to `stopped` state.

**Responses:**

- **`200 OK`** — stream stopped:

  ```json
  {
    "state": "stopped",
    "youtube_url": "https://youtube.com/watch?v=..."
  }
  ```

- **`404 Not Found`** — no stream was running:
  ```json
  {
    "error": "No active stream"
  }
  ```

---

### `GET /health`

Health check for container orchestration and debugging. Returns state of internal
components.

**Response `200 OK`:**

```json
{
  "status": "ok",
  "components": {
    "ffmpeg": {
      "status": "running",
      "pid": 12345,
      "uptime_seconds": 1842
    },
    "icecast": {
      "status": "reachable",
      "mountpoint_active": true
    }
  },
  "stream": {
    "state": "streaming",
    "youtube_url": "https://youtube.com/watch?v=...",
    "listeners": 3
  }
}
```

When no stream is running, `ffmpeg` and `stream` are omitted:

```json
{
  "status": "ok",
  "components": {
    "icecast": {
      "status": "reachable"
    }
  }
}
```

**Response `503 Service Unavailable`:**

```json
{
  "status": "degraded",
  "components": {
    "icecast": {
      "status": "unreachable",
      "error": "ECONNREFUSED 127.0.0.1:8000"
    }
  }
}
```

---

## State Machine

```
                 ┌──────────┐
    GET /stream  │   IDLE   │  (no pipeline, nothing persisted except maybe last URL)
     w/ url ────▶│          │
                 └─────┬────┘
                       │
                       ▼
                 ┌──────────┐
                 │ STARTING │  yt-dlp extracting, ffmpeg connecting to Icecast
                 └────┬─────┘
                      │
              ┌───────┴────────┐
              ▼                ▼
        ┌──────────┐    ┌──────────┐
        │STREAMING │    │  ERROR   │  yt-dlp failed, ffmpeg crash, Icecast unreachable
        └────┬─────┘    └────┬─────┘
             │               │
    DELETE   │        ┌──────┴──────┐              0 listeners > TTL
    /stream  │        ▼             ▼              ┌──────────────────┐
             │  ┌──────────┐  ┌──────────┐        │                  │
             │  │RETRYING  │  │ STOPPED  │  max   │                  │
             │  │(backoff) │  └──────────┘ retries│                  │
             │  └────┬─────┘       ▲              │                  │
             │       │ success     │              │                  │
             │       ▼            │              │                  │
             └─▶┌──────────┐      │              │                  │
                │ STOPPED  │◀─────┘              │                  │
                └──────────┘◀────────────────────┘                  │
                   manual DELETE, max retries, or TTL expiry
```

**Transitions:**

| From        | Trigger                     | To          | Notes                                                        |
| ----------- | --------------------------- | ----------- | ------------------------------------------------------------ |
| `IDLE`      | `GET /stream?url=...`       | `STARTING`  | Spawn yt-dlp + ffmpeg                                        |
| `STARTING`  | ffmpeg connects to Icecast  | `STREAMING` | Pipeline healthy, audio flowing                              |
| `STARTING`  | yt-dlp or ffmpeg fails      | `RETRYING`  | Retry with backoff (see below)                               |
| `RETRYING`  | Retry succeeds              | `STREAMING` |                                                              |
| `RETRYING`  | Max retries exhausted       | `STOPPED`   | 5 retries, 60s max backoff (see below)                       |
| `STREAMING` | ffmpeg exits unexpectedly   | `RETRYING`  | YouTube URL expired, network blip, etc.                      |
| `STREAMING` | `DELETE /stream`            | `STOPPED`   | Manual stop, kill ffmpeg via SIGTERM (then SIGKILL after 5s) |
| `STREAMING` | `GET /stream?url=<new>`     | `STARTING`  | Kill current pipeline, start new one                         |
| `STREAMING` | 0 listeners for TTL minutes | `STOPPED`   | Auto-stop to save resources (TTL defaults to 15 min)         |
| `STARTING`  | `GET /stream?url=<new>`     | `STARTING`  | Kill current startup, start new one                          |
| `STOPPED`   | `GET /stream?url=...`       | `STARTING`  | Clear stopped state, restart                                 |
| any         | `GET /stream?url=<same>`    | no change   | Idempotent — just redirect if streaming, or wait if starting |

**Retry strategy (exponential backoff):**

| Attempt | Delay |
| ------- | ----- |
| 1       | 1s    |
| 2       | 2s    |
| 3       | 4s    |
| 4       | 8s    |
| 5       | 16s   |
| 6+      | 60s   |

After **10 total retries**, give up and transition to `STOPPED`.

---

## Pipeline

5. **TTL auto-stop** — tracks consecutive idle time (zero listeners). When it exceeds
   `STREAM_TTL_MINUTES` (default 15), the pipeline is killed and state becomes
   `STOPPED`. Any new listener connection resets the idle timer.

### Extraction

```bash
yt-dlp -f bestaudio --get-url "<youtube_url>"
```

- `-f bestaudio` selects the highest-bitrate audio-only stream (typically Opus in WebM
  or AAC in MP4 — 128–160 kbps).
- Returns a direct stream URL valid for ~6 hours (YouTube expires signed URLs).
- On HTTP 403 from ffmpeg mid-stream, yt-dlp re-run to get a fresh URL (handled by the
  retry mechanism).

### Transcoding & Streaming to Icecast

```bash
ffmpeg \
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 \
  -i "<extracted_audio_url>" \
  -c:a libmp3lame -b:a 128k \
  -content_type audio/mpeg \
  -f mp3 \
  icecast://source:${ICECAST_SOURCE_PASSWORD}@${ICECAST_HOST}:${ICECAST_PORT}/stream
```

| Parameter                  | Purpose                                 |
| -------------------------- | --------------------------------------- |
| `-reconnect 1`             | Auto-reconnect on connection drop       |
| `-reconnect_streamed 1`    | Reconnect even mid-stream               |
| `-reconnect_delay_max 5`   | Max 5s wait between reconnect attempts  |
| `-c:a libmp3lame`          | MP3 audio codec                         |
| `-b:a 128k`                | 128 kbps constant bitrate               |
| `-content_type audio/mpeg` | Icecast metadata header for MP3         |
| `-f mp3`                   | MP3 container format                    |
| `icecast://...`            | Built-in ffmpeg Icecast output protocol |

**Bitrate:** Hardcoded to 128 kbps for PoC. No per-request override.

**Format:** MP3 only. No AAC, Ogg, or other codec support.

### Resource Limits

ffmpeg audio-only transcoding to MP3 128k is lightweight. The following Docker limits
are sufficient (set in `docker-compose.yml`):

| Resource | Limit    | Notes                         |
| -------- | -------- | ----------------------------- |
| CPU      | 0.5 vCPU | ~10% of one modern core       |
| Memory   | 128 MB   | ~50 MB typical for audio-only |

---

## Persistence (Resume on Restart)

The service persists enough state to **automatically resume** the last stream after a
restart or crash.

**Storage:** A single JSON file at `${DATA_DIR:-./data}/stream-state.json`.

```json
{
  "youtube_url": "https://youtube.com/watch?v=...",
  "state": "streaming"
}
```

**On startup:**

1. Read `stream-state.json` if it exists.
2. If `state` was `streaming` or `starting`, attempt to restart the pipeline.
3. If restart fails, follow normal retry → error → stopped logic.
4. If restart succeeds, the stream is live — nothing else changes.

**On state change:**

- Write `stream-state.json` atomically (write to temp file, then rename).
- State changes include: starting, streaming, error, stopped, idle (on DELETE).

**If the file is missing or corrupted:** Start in `IDLE` state.

---

## Icecast Configuration

Off-the-shelf Icecast 2.4 server with minimal config.

### Environment Variables (via Docker)

| Variable                  | Default     | Description                     |
| ------------------------- | ----------- | ------------------------------- |
| `ICECAST_SOURCE_PASSWORD` | `secret`    | Password for ffmpeg to push     |
| `ICECAST_ADMIN_PASSWORD`  | `admin`     | Password for admin API          |
| `ICECAST_HOSTNAME`        | `localhost` | Public hostname for ICY headers |

### Mountpoint

A single fixed mountpoint: `/stream`

No mountpoint management or dynamic creation needed.

### Admin API Usage

The service polls `GET http://icecast:${ICECAST_PORT}/admin/listmounts` (HTTP Basic Auth
with `admin:${ICECAST_ADMIN_PASSWORD}`) every **15 seconds** to:

- Verify the mountpoint is active
- Count current listeners
- Feed listener count into `GET /stream` and `GET /health` responses
- **TTL auto-stop**: when `listeners == 0` continuously for `STREAM_TTL_MINUTES`
  (default 15), kill the ffmpeg process and transition to `STOPPED`. An active
  listener that connects resets the idle timer.

---

## Configuration (Environment Variables)

### Stream Service

| Variable                  | Default     | Description                                              |
| ------------------------- | ----------- | -------------------------------------------------------- |
| `PORT`                    | `8080`      | API server listen port                                   |
| `ICECAST_HOST`            | `icecast`   | Icecast server hostname (Docker service name by default) |
| `ICECAST_PORT`            | `8000`      | Icecast server port                                      |
| `ICECAST_SOURCE_PASSWORD` | `secret`    | Source password for ffmpeg → Icecast                     |
| `ICECAST_ADMIN_PASSWORD`  | `admin`     | Admin password for polling Icecast API                   |
| `PUBLIC_HOSTNAME`         | `localhost` | Public hostname used in `302` redirect URLs              |
| `DATA_DIR`                | `./data`    | Directory for state persistence                          |
| `LOG_LEVEL`               | `info`      | Logging level: `debug`, `info`, `warn`, `error`          |
| `STREAM_TTL_MINUTES`      | `15`        | Auto-stop after N minutes with zero listeners            |

### Route Isolation

Only the four routes listed in the API specification are registered on the service's
HTTP port (`8080`):

- `GET /stream?url=...`
- `GET /stream`
- `DELETE /stream`
- `GET /health`

No Icecast admin endpoints, internal mountpoints, or any other URLs are proxied or
exposed. The Icecast port (`8000`) serves audio directly to clients; the API server
is a separate management interface only.

### Optional (PoC scope — env var wired but not required)

| Variable       | Default         | Description                                   |
| -------------- | --------------- | --------------------------------------------- |
| `YTDLP_PROXY`  | _(none)_        | Proxy URL for yt-dlp (`--proxy` flag)         |
| `COOKIES_PATH` | `./cookies.txt` | Path to cookies file for yt-dlp (`--cookies`) |

---

## Logging

JSON structured logs to stdout (compatible with Docker log drivers, `jq`, log
aggregators).

**Format (one JSON object per line):**

```json
{"level":"info","ts":"2025-01-01T12:00:00.000Z","msg":"stream started","youtube_url":"https://...","pid":12345}
{"level":"warn","ts":"2025-01-01T12:05:00.000Z","msg":"ffmpeg exited unexpectedly","code":1,"signal":null}
{"level":"error","ts":"2025-01-01T12:05:01.000Z","msg":"retry 3/10 failed","error":"Icecast connection refused"}
```

**Levels:**

- `info` — lifecycle events (stream started, stopped, retrying, listener count changes)
- `warn` — recoverable issues (ffmpeg exit → retrying, Icecast poll timeout)
- `error` — non-recoverable issues (max retries exhausted, API errors)
- `debug` — per-request details, Icecast poll responses, raw yt-dlp output (only when
  `LOG_LEVEL=debug`)

**Implementation:** Fastify's default logger (pino) with `pino-pretty`
disabled — pure JSON output to stdout.

---

## API Error Response Format

All error responses follow a consistent shape:

```json
{
  "error": "<human-readable message>",
  "details": "<optional technical detail>"
}
```

**HTTP status codes used:**

- `200` — success
- `202` — accepted, still processing
- `302` — redirect to Icecast
- `400` — bad request (missing/invalid parameters)
- `404` — resource not found (no active stream for DELETE)
- `500` — internal server error (pipeline failure)
- `503` — service unavailable (Icecast unreachable)

---

## Tech Stack

| Layer          | Choice                | Version  | Rationale                                  |
| -------------- | --------------------- | -------- | ------------------------------------------ |
| Runtime        | Node.js               | ≥ 24 LTS | Async I/O, native fetch, stable standard library    |
| HTTP framework | Fastify               | latest stable | Fast, schema-based, pino logger bundled          |
| Logging        | pino (bundled with Fastify) | —    | Zero-config JSON logging to stdout                  |
| HTTP client    | built-in              | —        | `fetch()` (Node 20+) for Icecast admin API |
| Process mgmt   | `child_process.spawn` | —        | Spawn yt-dlp and ffmpeg                    |
| Stream extract | yt-dlp                | latest   | Only tool that reliably handles YouTube    |
| Transcoder     | ffmpeg                | ≥ 5      | Audio transcoding to MP3                   |
| Stream server  | Icecast               | 2.4      | Industry-standard, ICY metadata, fan-out   |
| State store    | JSON file             | —        | Single-stream PoC, SQLite overkill         |
| Container      | Docker + Compose      | —        | Images pinned by digest, one-command deploy |

**No external dependencies beyond:**

- `fastify` — HTTP routing + JSON logging (pino bundled)

Everything else uses Node.js ≥ 24 LTS standard library (`child_process`, `fs`, `fetch`, `path`).

---

## Docker Compose Structure

```yaml
# docker-compose.yml
name: yt-stream
services:
  icecast:
    image: moul/icecast@sha256:b35cd6367327335b51b989c277e6feaff7cd61d65846ec7fee361c6eb1cea620   # pinned digest for reproducible builds
    ports:
      - "${ICECAST_PORT:-8000}:8000"
    environment:
      ICECAST_SOURCE_PASSWORD: "${ICECAST_SOURCE_PASSWORD:-secret}"
      ICECAST_ADMIN_PASSWORD: "${ICECAST_ADMIN_PASSWORD:-admin}"
      ICECAST_HOSTNAME: "${ICECAST_HOSTNAME:-localhost}"
    restart: unless-stopped

  stream-service:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "${PORT:-8080}:8080"
    volumes:
      - ./data:/app/data
      - ./cookies.txt:/app/cookies.txt:ro # optional
    environment:
      PORT: "8080"
      ICECAST_HOST: icecast
      ICECAST_PORT: "8000"
      ICECAST_SOURCE_PASSWORD: "${ICECAST_SOURCE_PASSWORD:-secret}"
      ICECAST_ADMIN_PASSWORD: "${ICECAST_ADMIN_PASSWORD:-admin}"
      PUBLIC_HOSTNAME: "${PUBLIC_HOSTNAME:-localhost}"
      DATA_DIR: /app/data
      LOG_LEVEL: "${LOG_LEVEL:-info}"
      STREAM_TTL_MINUTES: "${STREAM_TTL_MINUTES:-15}"
      YTDLP_PROXY: "${YTDLP_PROXY:-}" # optional
      COOKIES_PATH: /app/cookies.txt # optional
    restart: unless-stopped
    depends_on:
      - icecast
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: "256M"
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
│   └── stream-state.json   # { youtube_url, state }
├── cookies.txt             # Optional YouTube cookies for restricted videos
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

---

## Open Questions & Deferred Decisions

| #   | Question                                                                                 | Status                                                                   |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | ~~**TTL auto-stop**: Should the service auto-stop after N minutes with zero listeners?~~ | **Implemented.** Default 15 min, configurable via `STREAM_TTL_MINUTES`.  |
| 2   | **YouTube rate limiting**: What happens if YouTube blocks the server IP?                 | **Deferred.** Not handled in PoC. Proxy env var wired but not validated. |
| 3   | **Multiple bitrates / formats**: 128k MP3 only for PoC.                                  | **Deferred.** Config is hardcoded but structured for future extension.   |
| 4   | **Liquidsoap variant**: Mentioned in DESIGN.md for radio-grade reliability.              | **Deferred.** Future enhancement, out of PoC scope.                      |
| 5   | **Web UI / scheduling / recording**: Listed as future enhancements.                      | **Deferred.** Out of scope for PoC.                                      |

---

## Acceptance Criteria

1. **`GET /stream?url=<valid_youtube_url>`** → returns `302` redirect to Icecast
   mountpoint. Audio is playable in VLC, browser, or any Icecast-compatible client.

2. **`GET /stream`** → returns current state as JSON. `idle` when nothing is running,
   `streaming` with metadata when active.

3. **`DELETE /stream`** → stops the ffmpeg process, mountpoint goes silent, state
   transitions to `stopped`.

4. **`GET /health`** → returns `200` with component statuses when healthy, `503` when
   Icecast is unreachable.

5. **Re-POST with a different URL** while streaming → old pipeline is killed, new one
   starts, redirect points to new stream.

6. **Re-POST with the same URL** while streaming → idempotent, immediate `302` redirect
   (no pipeline restart).

7. **ffmpeg crashes mid-stream** → automatic retry with exponential backoff, transparent
   to clients (brief silence then audio resumes).

8. **Service restart** → automatically resumes last stream if it was active.

9. **All logs are JSON** to stdout, compatible with `docker logs` and log aggregators.

10. **Zero listeners for TTL duration** → ffmpeg is killed, state becomes `stopped`, resources freed.

12. **Only advertised routes exposed** — no Icecast admin API, mountpoints, or
    internal endpoints leak through the service's HTTP port (8080).

13. **Single `docker compose up`** brings up Icecast + stream-service, fully functional.
