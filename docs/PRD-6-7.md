# Product Requirements Document — YouTube Stream Service (Production)

## 1. Overview

Evolve the PoC into a production-ready, single-host service that converts a YouTube
live stream or video into an Icecast-compatible audio stream.

The PoC proved the core concept. This document defines the requirements for the
production version: hardened security, clean modular architecture, automated testing
and linting, and a reverse-proxy front door. Multi-stream support is explicitly
**deferred** to a future update (see §6).

### Guiding principles

- **Single entry point** — one public URL path; internal services are never exposed.
- **Convenience preserved** — a client can still start and tune into a stream with a
  single `GET` request.
- **Minimal dependencies** — Node built-ins where possible, only battle-tested
  external components.
- **Fail loud** — a failed start fails the HTTP request; no hidden retry loops.

---

## 2. Public API

The API moves under an `/api/` prefix to avoid collision with the `/stream` audio
mountpoint.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/stream?url=...` | ✅ | Start a stream; `302` redirect to audio mount |
| `GET` | `/api/stream` | ✅ | Current stream status (JSON) |
| `DELETE` | `/api/stream` | ✅ | Stop the current stream |
| `GET` | `/api/health` | ✅ | Component health (JSON) |
| `GET` | `/stream` | — | Audio mount (Icecast, public) |

**Start flow (single request):**

```
GET /api/stream?url=https://youtube.com/watch?v=...&key=<key>
  → 302 Location: /stream            (audio mount, no key needed)
  → 400 empty/invalid url
  → 401 missing/invalid key
  → 429 a stream operation is already in progress
  → 500 extraction/transcode/icecast failure
```

**Status vs start distinction:** `GET /api/stream` **without** a `url` query
parameter returns the current status (`200`). The `400` applies only when a `url`
is present but empty or invalid.

**Concurrency:** one in-flight operation at a time. The route holds a
`requestInProgress` flag; concurrent start/delete requests are dropped with `429`.

---

## 3. Security

### 3.1 Network exposure

- **Caddy** is the only public entry point (ports 80/443).
- `stream-service` and `icecast` bind **only** on the internal Docker network — no
  published host ports.
- Routing:

```
{$SITE_ADDRESS} {
    reverse_proxy /api/* stream-service:8080
    reverse_proxy /stream icecast:8000
    handle { respond 404 }
}
```

- Everything except `/api/*` and `/stream` returns 404. Icecast's `/admin/*`,
  `/status.xsl`, and `/` are unreachable externally.

### 3.2 API authentication

- `API_KEY` environment variable (required; no default in production).
- **Dual mode:**
  - Header: `Authorization: Bearer <key>`
  - Query param: `?key=<key>` — enabled only when `ALLOW_KEY_IN_QUERY=true`
- Applies to all `/api/*` endpoints including `/api/health`.
- The `/stream` audio mount is **not** key-protected (radio receivers cannot send
  headers).

### 3.3 Listener limit

- `ICECAST_MAX_LISTENERS` env var, **default 2**.
- Enforced in Icecast (`<max-listeners>` per mount) and again in the app using the
  existing listener polling (defense in depth).

### 3.4 HTTPS

- Caddy automatic HTTPS (Let's Encrypt) with the service domain.
- **Configurable via env:**
  - `SITE_ADDRESS` — e.g. `yt-stream.charugin.me` (auto-HTTPS) or `:80` (HTTP only).
- Redirect target in the start response is built from the same address.

### 3.5 Additional hardening

- **SSRF guard** — strict YouTube URL validation: only `youtube.com` / `youtu.be`,
  reject IPs, `@` tricks, and non-HTTP(S) schemes.
- **Secrets hygiene** — never log the API key; `cookies.txt` stays `0600` and is
  treated as a secret.
- **Container hardening** — non-root user, read-only root filesystem, `cap_drop: ALL`,
  `no-new-privileges: true`.
- **Icecast admin isolation** — admin API never exposed outside the internal network.
- **Branch protection** on `main` (require PR + passing CI).
- **Dependency & secret scanning** in CI — `npm audit`, Trivy image scan, `gitleaks`.
- **Dependabot** — automated update PRs for npm, Docker, and GitHub Actions
  dependencies.

---

## 4. Architecture & Code Quality

### 4.1 Module decomposition

Replace the monolithic `stream-manager.js` with focused modules:

```
src/
├── events.js       # event bus (pub/sub)
├── yt-dlp.js       # audio URL extraction
├── ffmpeg.js       # transcode, kill, replace process
├── icecast.js      # admin polling, readiness check, mountpoint state
├── stream.js       # orchestration ("main" module)
├── auth.js         # API key validation (Fastify hook)
├── routes.js       # HTTP handlers
├── config.js       # env config
└── index.js        # bootstrap
```

### 4.2 Control flow — no state machine

Drop the explicit state machine entirely. The single-flight `requestInProgress` flag
handles concurrency. Streaming state is a plain in-memory object:

```js
current = {
  url,          // YouTube URL
  ffmpegProc,   // child process handle
  listeners,    // last polled count
  idleSince,    // timestamp when listeners hit 0
  startedAt,
}
```

`start(url)` runs strictly sequentially with `async/await`:

1. `yt-dlp.extractUrl(url)` — obtain audio stream URL
2. `icecast.verifyReady()` — confirm Icecast accepts sources
3. `ffmpeg.replace(audioUrl)` — SIGTERM any old process, wait for the mountpoint to
   clear, spawn a fresh process
4. any step throwing fails the request (`500`); no retries

Background concerns (TTL, mountpoint loss) subscribe to the event bus rather than
living inside a state machine.

### 4.3 Event bus

A small pub/sub bus decouples the modules:

| Event | Emitted by | Consumed by |
|---|---|---|
| `stream:started` | stream | logging, TTL |
| `stream:stopped` | stream | logging |
| `stream:error` | stream | logging, health |
| `listeners:changed` | icecast | TTL, status |
| `ttl:expired` | stream (on listeners) | stops the stream |

### 4.4 Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `API_KEY` | *(required)* | API auth |
| `ALLOW_KEY_IN_QUERY` | `false` | Allow `?key=` query auth |
| `SITE_ADDRESS` | `:80` | Public address for Caddy + redirects |
| `ICECAST_MAX_LISTENERS` | `2` | Per-mount listener cap |
| `STREAM_TTL_MINUTES` | `15` | Auto-stop after N min of zero listeners |
| `ICECAST_SOURCE_PASSWORD` | — | Source auth (ffmpeg → Icecast) |
| `ICECAST_ADMIN_PASSWORD` | — | Admin API auth (internal polling) |
| `COOKIES_PATH` | — | yt-dlp cookies file |
| `LOG_LEVEL` | `info` | pino log level |

---

## 5. Testing & Linting

### 5.1 Unit tests — `node:test`

Every module gets unit tests. Use `node:test` + `mock` for `child_process` and
`fetch`. Cover basic and non-obvious scenarios:

- **yt-dlp** — valid URL, invalid/bot-blocked response, non-zero exit, timeout.
- **ffmpeg** — spawn args, kill+replace (mountpoint wait), process exit.
- **icecast** — ready/unreachable, mountpoint active/inactive, listener parse.
- **stream** — sequential happy path, failure propagation, single-flight.
- **auth** — header, query, missing/invalid key.
- **routes** — status codes (400/401/429/500/302).

### 5.2 Linting — `oxlint`

- Add `oxlint` as the linter, run via `npm run lint`.

### 5.3 CI (GitHub Actions)

- Run **lint + tests** on every PR open/update.
- Block merge when failing (via branch protection).

---

## 6. Future: Multi-stream design proposal

> Deferred — this section defines the shape, not the current scope.

**Goal:** run N concurrent YouTube → Icecast streams on one host.

**Model:**

- A `StreamRegistry` (Map) replaces the single `current` object.
- Each entry: `{ id, url, mountpoint, ffmpegProc, listeners, idleSince, startedAt }`.
- Mountpoints: `/stream/<id>` (Icecast natively supports many mounts).

**API:**

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/streams` | `{ url }` → `{ id, stream_url }` |
| `GET` | `/api/streams/:id` | status |
| `DELETE` | `/api/streams/:id` | stop |
| `GET` | `/api/streams` | list all |

**Concerns to resolve at design time:**

- **Resource limits** — cap concurrent streams (`MAX_STREAMS`), since each needs an
  ffmpeg + yt-dlp (memory spikes during challenge solving).
- **TTL per stream** — zero-listeners auto-stop applies independently.
- **Preserving the single-GET convenience** — a `default` stream (e.g. `/api/stream`)
  can remain a shortcut to stream `#1`.
- **Authentication** — same key scheme applies to all management endpoints.

---

## 7. Deployment

```yaml
services:
  caddy:            # public front door (80/443)
  stream-service:   # internal (8080, no host port)
  icecast:          # internal (8000, no host port)
```

- Caddy: official `caddy:2-alpine` image, Caddyfile generated from env.
- `stream-service` / `icecast`: as today, but with no published ports and added
  hardening (read-only rootfs, dropped caps, no-new-privileges).
- Deploy continues via the existing GitHub Actions SSH flow (pull + `docker compose up`).

---

## 8. Acceptance Criteria (production)

1. Only `/api/*` and `/stream` are reachable publicly; everything else (including
   Icecast admin) returns 404 externally.
2. `/api/stream?url=...` with a valid key starts a stream and `302`s to `/stream`.
3. Missing/invalid key returns 401; query-param auth works only when explicitly enabled.
4. More than `ICECAST_MAX_LISTENERS` clients are rejected.
5. HTTPS works via Caddy; HTTP-only mode is selectable by env.
6. Every module has unit tests; lint + tests run in CI on each PR and block merge.
7. A second stream start while one is in progress returns 429.
8. No explicit state machine remains; start/stop are sequential `async/await`.
