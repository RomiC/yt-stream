# Product Requirements Document — YouTube Stream Service (Production)

## 1. Overview

Evolve the PoC into a production-ready, single-host service that converts a YouTube live stream or video into an Icecast-compatible audio stream.

The PoC proved the core concept. This document defines the requirements for the production version: hardened security, clean modular architecture, automated testing and linting, and a reverse-proxy front door. Multi-stream support is explicitly **deferred** to a future update (see §6).

### Guiding principles

- **Single entry point** — one public URL path; internal services are never exposed.
- **Convenience preserved** — a client can still start and tune into a stream with a single `GET` request.
- **Minimal dependencies** — Node built-ins where possible, only battle-tested external components.
- **Fail loud** — a failed start fails the HTTP request; no hidden retry loops.

---

## 2. Public API

The API moves under an `/api/` prefix to avoid collision with the `/stream` audio mountpoint.

| Method   | Path                  | Auth | Purpose                                       |
| -------- | --------------------- | ---- | --------------------------------------------- |
| `GET`    | `/api/stream?url=...` | ✅   | Start a stream; `302` redirect to audio mount |
| `DELETE` | `/api/stream`         | ✅   | Stop the current stream                       |
| `GET`    | `/api/health`         | ✅   | Component health (JSON)                       |
| `GET`    | `/stream`             | —    | Audio mount (Icecast, public)                 |

**Start flow (single request):**

```
GET /api/stream?url=https://youtube.com/watch?v=...&key=<key>
  → 302 Location: /stream            (audio mount, no key needed)
  → 400 missing/invalid url
  → 401 missing/invalid key
  → 429 a stream operation is already in progress
  → 500 extraction/transcode/icecast failure
```

**Status:** served by `/api/health` (includes the current stream state and the Icecast listener count); `GET /api/stream` without a `url` returns `400` — the endpoint is start-only.

**Concurrency:** one in-flight operation at a time. The route holds a `requestInProgress` flag; concurrent start/delete requests are dropped with `429`.

---

## 3. Security

### 3.1 Network exposure

- **Caddy** is the only public entry point (ports 80/443).
- `stream-service` and `icecast` bind **only** on the internal Docker network — no published host ports.
- Routing:

```
{$PUBLIC_BASE_URL} {
    handle /api/* {
        reverse_proxy stream-service:8080
    }
    handle /stream {
        reverse_proxy icecast:8000
    }
    handle {
        respond 404
    }
}
```

> All routes must be `handle` blocks — mixing path-matched `reverse_proxy` with a bare
> `handle { respond 404 }` lets Caddy's directive ordering put the catch-all first.

- Everything except `/api/*` and `/stream` returns 404. Icecast's `/admin/*`, `/status.xsl`, and `/` are unreachable externally.

### 3.2 API authentication

- `API_KEY` environment variable (required; no default in production).
- **Dual mode:**
- Header: `Authorization: Bearer <key>`
- Query param: `?key=<key>` — enabled only when `ALLOW_KEY_IN_QUERY=true`
- Applies to all `/api/*` endpoints including `/api/health`.
- The `/stream` audio mount is **not** key-protected (radio receivers cannot send headers).

### 3.3 Listener limit

- `ICECAST_MAX_LISTENERS` env var, **default 2**.
- Enforced by Icecast alone (`<max-listeners>` per mount — excess clients are rejected at connect time). The cap is injected into the Icecast config by its container's start command and never reaches the service: the app is unaware of it.

### 3.4 HTTPS

- Caddy automatic HTTPS (Let's Encrypt) with the service domain.
- **Configurable via env:**
- `PUBLIC_BASE_URL` — full public base URL, e.g. `https://yts.charugin.me` (auto-HTTPS) or `http://yts.localhost` (HTTP only, local dev). Used as the Caddy site address and to build absolute stream URLs.

### 3.5 Additional hardening

- **SSRF guard** — strict YouTube URL validation: only `youtube.com` / `youtu.be`, reject IPs, `@` tricks, and non-HTTP(S) schemes.
- **Secrets hygiene** — never log the API key; `cookies.txt` stays `0600` and is treated as a secret.
- **Container hardening** — non-root user, read-only root filesystem, `cap_drop: ALL`, `no-new-privileges: true`.
- **Icecast admin isolation** — admin API never exposed outside the internal network.
- **Branch protection** on `main` (require PR + passing CI).
- **Dependency & secret scanning** in CI — `npm audit`, Trivy image scan, `gitleaks`.
- **Dependabot** — automated update PRs for npm, Docker, and GitHub Actions dependencies.

---

## 4. Architecture & Code Quality

### 4.1 Module decomposition

Replace the monolithic `stream-manager.js` with focused modules:

```
src/
├── events.js         # event bus + exported Event map (stream:* notifications)
├── childProcess.js   # base class: process lifecycle, kill, ships stderr to the owner via the exit payload
├── streamlink.js     # streamlink process: fetch the stream
├── ffmpeg.js         # ffmpeg process: transcode stdin → Icecast output URL
├── icecast.js        # passive admin client (getStatus), sourceUrl, streamUrl, mount-clear readiness
├── healthMonitor.js  # /health facade: status snapshot + ok/failure verdict
├── stream.js         # orchestration: StreamPipeline (per-generation pipeline: processes, readiness, derived phase) + live-pipelines map; status snapshot
├── ttlWatcher.js     # zero-listener TTL: polls Icecast, notifies owner via onExpired
├── auth.js           # API key validation (Fastify hook)
├── routes.js         # HTTP handlers
├── config.js         # env config
├── utils/
│   └── isValidYoutubeUrl.js  # SSRF-guard URL validation
└── index.js          # bootstrap
```

### 4.2 Control flow — no state machine

Drop the explicit state machine entirely. The single-flight `requestInProgress` flag handles concurrency. Each generation is a `StreamPipeline` that owns its own streamlink/ffmpeg/TTL watcher and the Icecast client; `Stream` keeps a map of live pipelines (`#pipelines`, keyed by id) and a `#current` pointer to the active one (null once it stops). Its phase is derived, not stored:

```js
// a StreamPipeline
current = {
  id, // unique per generation
  url, // YouTube URL
  startedAt, // when the mount became active (for uptime)
  streamlink,
  ffmpeg,
  ttlWatcher, // owned by this pipeline
  phase, // 'starting' | 'streaming' | 'stopped'  — derived from process liveness + mount readiness
};
```

`start(url)` runs strictly sequentially with `async/await`:

1. stop any existing pipeline (kill streamlink + ffmpeg, await exit; emits `stream:stopped` with reason `replaced`)
2. `icecast.prepareMountPoint()` — Icecast reachable and mount free (old source released)
3. streamlink picks a proxy itself — a random entry from `config.proxyList` (null when none)
4. `StreamPipeline.start(outputUrl)` — spawns streamlink + ffmpeg, pipes them, then waits for the mount itself
5. the pipeline polls the Icecast mountpoint (30s budget) and fails fast when a process exits (attributed with its exit code/signal and stderr)
6. any step throwing fails the request (`500`); no retries

Background concerns are observed directly, without the bus: `StreamPipeline` is the subscription unit for its own pipeline — it wires both process wrappers and the TTL watcher, exposing `onExit` (unexpected exits only, deliberate kills stay silent) and `onExpired`. Operational logging is centralized in Stream — collaborators expose facts (full stderr in the exit payload, the redacted `lastProxy`) instead of logging. On expiry the TTL watcher stops itself; Stream reacts by stopping the pipeline. A stream that lost its source (mount gone) is stopped by the same TTL watcher (no listeners → TTL). An unreachable Icecast counts as zero listeners — admin, source and listeners share port 8000, so nobody can be listening — which also reaps a blackholed pipeline where ffmpeg blocks silently without exiting.

### 4.3 Event bus

A small pub/sub bus carries the outward stream lifecycle notifications — Stream is the only emitter, `index.js` (logging) the consumer. Internal concerns (process exits, TTL expiry) are observed directly via the per-pipeline `onExit`/`onExpired`, never through the bus. `onExit` fires only for unexpected exits (deliberate kills stay silent) with `{ code, signal, pid, errors }` — the signal makes external kills (OOM, `docker kill`) self-explaining.

| Event            | Emitted by | Consumed by |
| ---------------- | ---------- | ----------- |
| `stream:started` | stream     | logging     |
| `stream:stopped` | stream     | logging     |
| `stream:error`   | stream     | logging     |

Every pipeline teardown declares its reason — `stream:stopped` carries one of `manual`, `replaced`, `process-exit` or `ttl`. A replace records the old stream's end **before** the new start is attempted, so a failed replacement cannot leave it unaccounted for; a failed start itself surfaces as `stream:error` (it never emitted `stream:started`).

### 4.4 Configuration (env vars)

| Variable                  | Default            | Purpose                                                    |
| ------------------------- | ------------------ | ---------------------------------------------------------- |
| `API_KEY`                 | _(required)_       | API auth                                                   |
| `ALLOW_KEY_IN_QUERY`      | `false`            | Allow `?key=` query auth                                   |
| `PUBLIC_BASE_URL`         | `http://localhost` | Public base URL: Caddy site address + absolute URLs        |
| `ICECAST_MAX_LISTENERS`   | `2`                | Per-mount listener cap (Icecast only)                      |
| `STREAM_TTL_MINUTES`      | `15`               | Auto-stop after N min of zero listeners (polled every 60s) |
| `ICECAST_SOURCE_PASSWORD` | —                  | Source auth (ffmpeg → Icecast)                             |
| `ICECAST_ADMIN_PASSWORD`  | —                  | Admin API auth (internal polling)                          |
| `PROXY_FILE`              | —                  | JSON array of proxy URLs → `config.proxyList`              |
| `STREAMLINK_QUALITY`      | `audio_only,worst` | streamlink `--default-stream`                              |
| `LOG_LEVEL`               | `info`             | pino log level                                             |

---

## 5. Testing & Linting

### 5.1 Unit tests — `node:test`

Every module gets unit tests. Use `node:test` with built-in `mock.fn()` and `mock.module` (run with `--experimental-test-module-mocks`), plus real processes where sensible (the `ChildProcess` base is tested against real `node` processes). Tests mirror the `src/` tree under `test/`. Cover basic and non-obvious scenarios:

- **childProcess** — real spawn/kill (SIGTERM → SIGKILL fallback), replace, stderr in the exit payload, spawn errors.
- **streamlink** — spawn args, proxy picking (random from config), error tail.
- **ffmpeg** — spawn args, output URL, process exit.
- **icecast** — ready/unreachable, mountpoint active/inactive, listener parse, `prepareMountPoint`.
- **stream** — sequential happy path, mountpoint readiness (polling, fail-fast on exit, timeout) inside the pipeline, failure propagation, replace, TTL, process-exit handling.
- **auth** — header, query, missing/invalid key.
- **routes** — status codes (400/401/429/500/302).
- **utils/isValidYoutubeUrl** — SSRF cases.

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

| Method   | Path               | Purpose                          |
| -------- | ------------------ | -------------------------------- |
| `POST`   | `/api/streams`     | `{ url }` → `{ id, stream_url }` |
| `GET`    | `/api/streams/:id` | status                           |
| `DELETE` | `/api/streams/:id` | stop                             |
| `GET`    | `/api/streams`     | list all                         |

**Concerns to resolve at design time:**

- **Resource limits** — cap concurrent streams (`MAX_STREAMS`), since each needs an ffmpeg + streamlink (memory spikes during challenge solving).
- **TTL per stream** — zero-listeners auto-stop applies independently.
- **Preserving the single-GET convenience** — a `default` stream (e.g. `/api/stream`) can remain a shortcut to stream `#1`.
- **Authentication** — same key scheme applies to all management endpoints.

---

## 7. Deployment

```yaml
services:
  caddy: # public front door (80/443)
  stream-service: # internal (8080, no host port)
  icecast: # internal (8000, no host port)
```

- Caddy: official `caddy:2-alpine` image (digest-pinned), static Caddyfile using env-var placeholders (`{$PUBLIC_BASE_URL}`).
- `stream-service` / `icecast`: no published ports; hardened — read-only rootfs (tmpfs `/tmp` for scratch), `cap_drop: ALL`,
  `no-new-privileges: true`, non-root users. Icecast runs as the image's own `icecast2` user (101:102): the root+sudo
  `/start.sh` entrypoint is bypassed (sudo needs `CAP_SETUID`), and the compose command patches credentials and
  `max-listeners` into a tmpfs copy of the config (`/etc/icecast2` stays intact — `/usr/share/icecast2` web/admin files
  symlink into it).
- Logging: every service logs to stdout/stderr → `docker logs` (pino, Caddy, Icecast via `/dev/stderr`, access log off).
  `json-file` driver with rotation (10 MB × 3) on all services; `docker compose logs --timestamps` shows unified UTC stamps.

---

## 8. Acceptance Criteria (production)

1. Only `/api/*` and `/stream` are reachable publicly; everything else (including Icecast admin) returns 404 externally.
2. `/api/stream?url=...` with a valid key starts a stream and `302`s to `/stream`.
3. Missing/invalid key returns 401; query-param auth works only when explicitly enabled.
4. More than `ICECAST_MAX_LISTENERS` clients are rejected.
5. HTTPS works via Caddy; HTTP-only mode is selectable by env.
6. Every module has unit tests; lint + tests run in CI on each PR and block merge.
7. A second stream start while one is in progress returns 429.
8. No explicit state machine remains; start/stop are sequential `async/await`.
