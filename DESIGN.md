# yt-stream — Design

A self-hosted service that converts a YouTube live stream or video into an Icecast-compatible MP3 audio stream. A single `GET /api/stream?url=…` request starts the pipeline and redirects to the audio mountpoint. Exactly **one stream** runs at a time; starting a new URL replaces the current one.

Sections 1–11 describe the current implementation. [Section 12](#12-multi-stream-contract-7) defines the target multi-stream contract for #7; it is not implemented yet.

## Table of contents

- [Guiding principles](#guiding-principles)
- [1. Architecture](#1-architecture)
  - [Package layout (Bun workspaces)](#package-layout-bun-workspaces)
- [2. Network & port model](#2-network--port-model)
  - [Caddy routing](#caddy-routing)
- [3. Public API & authentication](#3-public-api--authentication)
  - [3.1 Authentication](#31-authentication)
  - [3.2 Start flow & concurrency](#32-start-flow--concurrency)
  - [3.3 YouTube URL compatibility](#33-youtube-url-compatibility)
- [4. Stream lifecycle](#4-stream-lifecycle)
  - [4.1 No state machine](#41-no-state-machine)
  - [4.2 Start sequence](#42-start-sequence)
  - [4.3 Failure semantics & auto-stop](#43-failure-semantics--auto-stop)
  - [4.4 Timeout and retry reference](#44-timeout-and-retry-reference)
  - [4.5 Failure and recovery matrix](#45-failure-and-recovery-matrix)
  - [4.6 Registry groundwork](#46-registry-groundwork)
- [5. Event bus](#5-event-bus)
- [6. Health monitoring (#18)](#6-health-monitoring-18)
- [7. Security design](#7-security-design)
  - [7.1 API authentication](#71-api-authentication)
  - [7.2 SSRF guard](#72-ssrf-guard)
  - [7.3 Listener limit](#73-listener-limit)
  - [7.4 Secrets hygiene](#74-secrets-hygiene)
  - [7.5 Container hardening](#75-container-hardening)
  - [7.6 CI scanning](#76-ci-scanning)
- [8. Dependency pinning policy](#8-dependency-pinning-policy)
- [9. Logging](#9-logging)
- [10. Testing, linting & CI](#10-testing-linting--ci)
- [11. Recorded decisions log](#11-recorded-decisions-log)
- [12. Multi-stream contract (#7)](#12-multi-stream-contract-7)
  - [12.1 API and input identity](#121-api-and-input-identity)
  - [12.2 Response schemas and health](#122-response-schemas-and-health)
  - [12.3 Concurrency and lifecycle](#123-concurrency-and-lifecycle)
  - [12.4 Capacity and deployment resources](#124-capacity-and-deployment-resources)
  - [12.5 Errors and cancellation](#125-errors-and-cancellation)
  - [12.6 Migration and delivery](#126-migration-and-delivery)

### Guiding principles

- **Single entry point** — the application is reachable only through Caddy (one public URL); the health monitor is the single deliberate exception, published on its own port.
- **Convenience preserved** — a client can start and tune into a stream with a single `GET` request.
- **Minimal dependencies** — built-ins where possible; only battle-tested external components (streamlink, ffmpeg, Icecast, Caddy).
- **Fail loud** — a failed start fails the HTTP request; the start-attempt rotation is logged (proxy per attempt), never hidden.

---

## 1. Architecture

Four containers on one Docker network, plus a shared build context:

```
            ┌──────────── host ────────────┐
 HTTP/HTTPS │  caddy :80/:443  (front door)│──── /api/* ──▶ stream :8080 (internal)
 HEALTH_PORT│                              │──── audio ──▶ icecast :8080 (internal)
            │  health :8080 (published)    │
            └──────────────────────────────┘
             caddy liveness :8089 (internal only)
```

- **caddy** — reverse proxy, the only public door. TLS when `PUBLIC_BASE_URL` is `https://…`: automatic HTTPS (Let's Encrypt) by default, or operator-provided certificates (§2); HTTP-only mode for local dev. Also exposes a static liveness route on an internal-only port.
- **stream** — Bun application: URL validation, the `streamlink → ffmpeg` pipeline, Icecast admin polling, TTL auto-stop, metadata push. Internal port only.
- **icecast** — off-the-shelf streaming server (`moul/icecast`, digest-pinned). Serves audio mounts and an admin API to the internal network. A default mount policy caps listeners independently for every source mount; the application currently publishes only `/stream`.
- **health** — independent failure domain (#18). Probes the three components from the outside over plain HTTP and aggregates the result.

### Package layout (Bun workspaces)

```
packages/
├── shared/                     # yt-stream-shared — env Config + shared helpers
│   ├── lib/config.ts           #   immutable env config (constructor takes an env object)
│   ├── lib/logger.ts           #   pino-shaped JSON logger (both call forms)
│   ├── lib/withRateLimit.ts    #   fixed-window limiter + withRateLimit route wrapper
│   ├── lib/serverResponse.ts   #   JSON response helpers (404/429/500 + rate-limit headers)
│   ├── lib/types.ts            #   shared types (RequestHandler)
│   └── index.ts                #   public exports
├── stream/src/
│   ├── events.ts               # event bus + exported Event map (stream:* notifications)
│   ├── childProcess.ts         # one-shot wrapper: one instance = one process (spawn/kill/exit payload)
│   ├── streamlink.ts           # streamlink process: fetch the stream
│   ├── proxyList.ts            # ProxyList entity: optional file → pool (warn+degrade), request-scoped rotation
│   ├── ffmpeg.ts               # ffmpeg process: transcode stdin → Icecast output URL
│   ├── icecastClient.ts        # mount-scoped Icecast client: status/listeners, URLs, metadata, mount-clear readiness
│   ├── statusReport.ts         # /api/state snapshot + ok/failure verdict
│   ├── status.ts               # stream/probe status types
│   ├── streamPipeline.ts       # one stream generation: fresh streamlink/ffmpeg pair per attempt, readiness, TTL
│   ├── stream.ts               # current single-stream orchestration, health snapshot
│   ├── streamRegistry.ts       # internal UUID registry: independent pipeline/mount ownership and removal
│   ├── ttlWatcher.ts           # zero-listener TTL: polls Icecast, notifies owner via onExpired
│   ├── withAuth.ts             # API-key validation decorator
│   ├── withLock.ts             # single-operation concurrency lock (429)
│   ├── withLogging.ts        # request-logging decorator (redacts ?key=)
│   ├── server.ts               # Bun.serve: routes /api/stream + /api/state
│   ├── utils/
│   │   ├── isValidYoutubeUrl.ts  # boolean URL validation
│   │   ├── getYoutubeVideoId.ts  # ID extraction from an already validated URL
│   │   ├── resolveYoutubeSource.ts # source selection + canonical video identity (#7 groundwork)
│   │   ├── redactProxy.ts        # strip proxy credentials for logging
│   │   ├── redactApiKey.ts       # strip the API key from logged URLs
│   │   └── getYoutubeMeta.ts     # YouTube oEmbed metadata
│   └── index.ts                # bootstrap
├── health/src/
│   ├── check.ts                # base class: timed check envelope (result / duration / error)
│   ├── streamCheck.ts          # GET stream:8080/api/state with bearer auth
│   ├── icecastCheck.ts         # GET icecast:8080/admin/stats (basic auth)
│   ├── caddyCheck.ts           # GET caddy:8089/hc — Caddy's own liveness route
│   ├── config.ts               # check constants (timeout, rate limit)
│   ├── server.ts               # Bun.serve: routes /hc + /health, error handling
│   └── index.ts                # bootstrap
├── caddy/Caddyfile
├── icecast/icecast.xml
└── Dockerfile.bun             # shared build for stream & health (SERVICE build arg)
```

Tests mirror each package's `src/` tree under `tests/`.

---

## 2. Network & port model

- **Caddy** is the application's entry point (host ports `HTTP_PORT`/`HTTPS_PORT`, default 80/443).
- The **health** monitor is published separately on `HEALTH_PORT` (default 8080) — the only other exposed surface, by decision.
- `stream` and `icecast` bind **only** on the internal Docker network — no published host ports.

Container-internal ports are **fixed, not configurable**: stream, icecast and health all listen on 8080 (per-container network namespaces — no conflict); Caddy's liveness route lives on 8089. Only host-published ports are env-configurable.

For local development, prefer `PUBLIC_BASE_URL=http://yts.localhost` over bare `localhost` to distinguish this service from other local services. Caddy uses that hostname as its site address, so send requests to the same hostname. With the stock Compose configuration, keep `PUBLIC_BASE_URL` portless and include a non-standard host port only in client request URLs. For example, `PUBLIC_BASE_URL=http://yts.localhost` with `HTTP_PORT=8081` is accessed at `http://yts.localhost:8081`: Compose maps host port 8081 to container port 80. Adding `:8081` to `PUBLIC_BASE_URL` would change Caddy's internal listener to 8081 and break that mapping. The hostname alone does not prevent host-port conflicts. If the client cannot resolve `.localhost` names, map `yts.localhost` to `127.0.0.1` in the hosts file.

### Caddy routing

```
{$PUBLIC_BASE_URL} {
	import /etc/caddy/tls.caddy
	handle /api/* {
		reverse_proxy stream:8080
	}
	@audio path_regexp audio ^/stream(?:/[A-Za-z0-9_-]+)?$
	handle @audio {
		reverse_proxy icecast:8080
	}
	handle {
		respond 404
	}
}

:8089 {
	handle /hc {
		respond 200
	}
}
```

> All routes must be `handle` blocks — mixing path-matched `reverse_proxy` with a bare
> `handle { respond 404 }` lets Caddy's directive ordering put the catch-all first.

Caddy's TLS mode is decided once at container start, because the Caddyfile has no conditionals (`tls` is never optional, and importing a missing file is a fatal config error). The operator's pair is handed over as two **file** binds — `TLS_CERT_FILE`/`TLS_KEY_FILE` host paths, mounted at fixed in-container paths `/certs/fullchain.pem` and `/certs/privkey.pem`. File mounts (not a directory) let Docker resolve symlink sources on the host at container creation, so certbot's `live/<domain>/` paths work as-is; a directory mount of `live/<domain>/` would dangle, since its links point at `../../archive/…` which doesn't exist inside the container.

A wrapper writes `/etc/caddy/tls.caddy` — `tls /certs/fullchain.pem /certs/privkey.pem` when both files are non-empty, otherwise a comment (a valid, empty snippet) — and the site block imports it; the wrapper always writes the file, so the `import` never dangles. With the pair provided Caddy skips ACME (`auto_https` logs "skipping automatic certificate management"); with the variables unset an empty committed placeholder is mounted instead, and the automatic-HTTPS / HTTP-only modes behave exactly as before (`create_host_path: false` makes a typo'd path fail `up` loudly, as with `PROXY_FILE` #12).

Renewal is operator-owned. The symlink resolution is pinned for the container's lifetime and Caddy does **not** re-read file-loaded certificates in a running process ([caddy#5139](https://github.com/caddyserver/caddy/issues/5139)), so a renewed pair requires recreating only Caddy with `up -d --no-deps --no-build --force-recreate caddy` and the deployment's environment files/Compose overrides — automated by a certbot deploy hook in `/etc/letsencrypt/renewal-hooks/deploy/` (README has the production script). A brief listener drop per renewal is accepted over a copy-and-`caddy reload` pipeline.

Everything except `/api/*`, `/stream`, and `/stream/<id>` returns 404 externally. The audio matcher accepts one ID segment containing letters, digits, underscores, or hyphens; nested paths, dots, and traversal paths do not match. `handle` preserves the full mount path and query string when proxying; do not replace it with `handle_path`. Icecast's `/admin/*`, `/status.xsl`, and `/` remain unreachable from outside the Docker network.

Dynamic audio routing prepares the infrastructure for #7; it does not create streams or change the current single-stream API. `/stream` remains available until API cutover. An audio mount with no connected source returns Icecast's `404`.

---

## 3. Public API & authentication

| Method   | Path                                     | Auth | Purpose                                       |
| -------- | ---------------------------------------- | ---- | --------------------------------------------- |
| `GET`    | `/api/stream?url=…`                      | ✅   | Start a stream; `302` redirect to audio mount |
| `DELETE` | `/api/stream`                            | ✅   | Stop the current stream                       |
| `GET`    | `/api/state`                             | ✅   | Service state + health verdict (JSON)         |
| `GET`    | `/stream`                                | —    | Current audio mount (Icecast, public)         |
| `GET`    | `/stream/<id>`                           | —    | Dynamic audio mount routing (#7 groundwork)   |
| `GET`    | `/hc` (alias `/health`) on `HEALTH_PORT` | —    | Aggregated component health                   |

### 3.1 Authentication

- `API_KEY` env var (dev fallback `dev-api-key` with a startup warning).
- **Dual mode:** `Authorization: Bearer <key>` header, or `?key=<key>` query param enabled only when `ALLOW_KEY_IN_QUERY=true`. Query-key authentication enables a single start-and-play URL that can be pasted directly into a player without custom headers: `/api/stream?key=<key>&url=<encoded-youtube-url>` starts the stream and redirects to the public audio mount.
- Enable query authentication for that player-link workflow; otherwise leave it disabled (the default) or turn it off. Such links carry the API key and can leak through player/browser history or Caddy's error log; treat them as credentials. The player must follow HTTP redirects.
- Comparison is constant-time (`timingSafeEqual`). The `withLogging` decorator uses `redactApiKey` to scrub the `key` param from logged URLs — the redactor matches the _decoded_ param name, so percent-encoding (`?k%65y=`) cannot smuggle the key into logs.
- Applies to all `/api/*` endpoints, including `/api/state`.
- The `/stream` and `/stream/<id>` audio mounts are **not** key-protected: radio receivers cannot send headers.

### 3.2 Start flow & concurrency

```
GET /api/stream?url=https://youtube.com/watch?v=...
  → 302 Location: /stream            (audio mount, no key needed)
  → 400 missing/invalid url
  → 401 missing/invalid key
  → 429 a stream operation is already in progress
  → 500 extraction/transcode/icecast failure
```

One in-flight operation at a time: a shared `Lock` guards the routes via the `withLock` decorator; concurrent start/delete requests are dropped with `429`. `GET /api/stream` without a `url` returns `400` — the endpoint is start-only; status is served by `/api/state`. Requesting the **same URL** while it is already streaming is idempotent — an immediate `302` without restarting the pipeline.

### 3.3 YouTube URL compatibility

`isValidYoutubeUrl` parses with `new URL()`, checks the protocol, hostname, supported pathname, and ID syntax, and returns only `true` or `false`. It does not call the extractor. After validation succeeds, `getYoutubeVideoId` extracts the case-preserved ID without validation. Supported HTTP(S) URL forms have an optional `www.` host prefix and an exactly 11-character ID containing letters, digits, underscores, or hyphens:

| URL form   | Example                                |
| ---------- | -------------------------------------- |
| Watch      | `https://www.youtube.com/watch?v=<id>` |
| Live       | `https://youtube.com/live/<id>`        |
| Shorts     | `https://youtube.com/shorts/<id>`      |
| Short link | `https://youtu.be/<id>`                |

URL parsing follows standard WHATWG normalization; validation operates on the parsed fields without imposing additional raw-input restrictions. Only `youtube.com` and `youtu.be` hosts (optionally prefixed with `www.`) and the supported path forms are accepted. Short/live/shorts paths may have an optional trailing slash but no additional segments after normalization. Watch URLs require exactly one `v` parameter, in any query position. HTTP(S) schemes are required; credentials and non-default ports are rejected. Explicit default ports are accepted by standard URL parsing. Validation checks ID syntax, not video existence or access rights. Encode the complete YouTube URL as the API's `url` parameter to preserve any `&` characters.

The internal `resolveYoutubeSource(URLSearchParams)` helper prepares source identity for multi-stream support (#7); it is not yet wired to the server. It returns `null` when neither `url` nor `video_id` is supplied, otherwise only the case-preserved video ID string. The pipeline integration constructs the canonical `https://www.youtube.com/watch?v=<id>` URL when needed; the resolver does not return redundant derived data. Empty, conflicting, repeated, or invalid source parameters raise `InvalidYoutubeSourceError`. Unrelated parameters, including the API key, do not select a source.

For URL inputs, the resolver calls `isValidYoutubeUrl` once and, only on success, calls `getYoutubeVideoId`. The extractor assumes valid input: it parses for extraction but performs no checks and calls no validator. The resolver does not revalidate the extracted ID. Bare `video_id` inputs are validated separately. Tracking, timestamp, playlist, and fragment options are discarded; equivalent inputs resolve to the same video identity. The existing `/api/stream` endpoint also uses `isValidYoutubeUrl`, so malformed URLs formerly accepted by the prefix guard now return `400`. Its routes, successful start-and-play flow, and replacement behavior remain unchanged until API cutover.

URL acceptance does **not** guarantee extraction: the pinned streamlink YouTube plugin must find a playable stream using `STREAMLINK_QUALITY` (default `audio_only,worst`), and YouTube must allow access from the selected exit IP. There is no application-level cookies/login configuration for restricted sources. The API does not distinguish live from finite sources: it runs whatever streamlink extracts. A finite source ending cleanly stops the pipeline with `process-exit`, just like another child-process exit; it does not loop or resume.

The URL forms and lifecycle handling are covered by unit tests. Automated end-to-end coverage against real YouTube sources is not currently provided. The Compose stack also pins Icecast to `linux/amd64`; an ARM host needs amd64 emulation support.

---

## 4. Stream lifecycle

### 4.1 No state machine

There is no explicit state machine. Each generation is a `StreamPipeline` that owns the TTL watcher, the `IcecastClient`, and the current streamlink/ffmpeg pair — a **fresh pair per start attempt**: a wrapper instance mirrors exactly one process, so a retry constructs new instances. `Stream` keeps a single active record pairing its lifecycle event ID with the pipeline. Each registry entry likewise owns exactly one pipeline; pipelines have no separate ID. Callbacks retain their owning record, and object identity guards against stale callbacks. The pipeline's phase is **derived, not stored** — process liveness plus a readiness flag set once mount activation succeeds:

- `starting` — processes alive, startup readiness not yet confirmed
- `streaming` — processes alive, startup readiness confirmed
- `stopped` — either process dead

The readiness flag is not continuously refreshed. `/api/state` separately probes the current Icecast mount, so `general.state: streaming` can coexist with an unavailable or stopped mount and a `failure` health verdict.

Each `IcecastClient` accepts an optional `mountpoint`, defaulting to `/stream`. Source/playback URLs, listener and activity probes, mount-release waits, and metadata updates all refer to that client's immutable mount selection on the same shared Icecast server. Matching is literal and case-sensitive, so a neighboring mount, case variant, or filename containing a regex metacharacter cannot satisfy another client's probe. Poll-failure logs identify the selected mount.

Mountpoints must be absolute paths with non-empty segments containing only URI-unreserved characters (`A–Z`, `a–z`, digits, `.`, `_`, `~`, `-`); `.` and `..` segments, trailing slashes, query/fragment delimiters, percent escapes, whitespace, and credentials are rejected at construction. This keeps source/playback URLs and Icecast's mount name identical without encoding or path normalization. The current `Stream` still uses the default mount: public routes, Caddy configuration, and single-stream orchestration are unchanged in this preparatory step for #7.

### 4.2 Start sequence

`start(url)` runs strictly sequentially with `async/await`:

1. If the same URL is already streaming — return immediately (idempotent).
2. Stop any existing pipeline — the TTL watcher first, then both processes killed in parallel and awaited (the old stream ends with reason `replaced` **before** the new start is attempted, so a failed replacement cannot leave it unaccounted for).
3. `prepareMountPoint()` — Icecast reachable and the mount free (old source released).
4. The pipeline draws the proxy from a per-request `ProxyList` rotation: a fresh shuffle per start, attempts advance without repeating (reshuffling once exhausted). An empty pool means direct connection — the optional file's absence or malformation warns but never blocks startup.
5. Spawn streamlink + ffmpeg, pipe them, then wait for the Icecast mount to become active (30 s budget, 500 ms poll interval) — proof the pipeline works end-to-end. A failed attempt is retried up to 3 times: both processes are torn down and the pipeline **advances to the next pool entry**, reusing proxies only once the pool is exhausted. Each attempt logs the redacted proxy.
6. Fail fast when a process exits before the mount is active (attributed with its exit code/signal and stderr tail); a timeout also fails the attempt. Exhausted attempts fail the request (the failure log carries the last proxy); any other step throwing maps to `500` — no retries outside the start-attempt loop.
7. On success: start the TTL watcher, fetch YouTube oEmbed metadata and push `<author> - <title>` to Icecast (best-effort — unavailable metadata never fails the stream), emit `stream:started`.

A failed start tears the failed pipeline down and emits `stream:error` (it never emitted `stream:started`).

### 4.3 Failure semantics & auto-stop

- **Process wrappers are one-shot** — each instance mirrors exactly one process: constructed, spawned once, running, exited (terminal); a second spawn throws. The owner marks a kill _before_ signaling, so its close is silent; every other exit — including a clean `code: 0` end of a finite source — reaches `onExit` with `{ cmd, code, signal, pid, errors }`. The consumer interprets: the same payload means "source ended", "attempt failed", or "crash" depending on the phase.
- **Unexpected process exit** (streamlink or ffmpeg dies) → the pipeline is stopped with reason `process-exit`; the signal in the exit payload makes external kills (OOM, `docker kill`) self-explaining.
- **Zero-listener TTL** — the TTL watcher polls Icecast every 60 s; `STREAM_TTL_MINUTES` (default 15) of zero listeners tears the pipeline down (reason `ttl`).
- A stream that lost its source (mount gone) is reaped by the same TTL watcher (no listeners → TTL). An **unreachable Icecast** counts as zero listeners — admin, source and listeners share port 8080, so nobody can be listening — which also reaps a black-holed pipeline where ffmpeg blocks silently without exiting.
- **Manual stop** (`DELETE /api/stream`) → reason `manual`.

### 4.4 Timeout and retry reference

These are application defaults, not configurable environment variables unless noted. Streamlink/ffmpeg can also have their own upstream retry and timeout behavior.

| Operation              | Default                                | Behavior                                                                                                                             |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Pipeline startup       | 3 attempts                             | Fresh child processes and the next proxy per attempt; after exhausting the pool, reshuffle. No application backoff between attempts. |
| Mount activation       | 30 s per attempt, 500 ms poll interval | Process exit or unreachable Icecast fails the attempt early.                                                                         |
| Old mount release      | 10 s, 500 ms poll interval             | Required before startup and between retries; failure aborts the start rather than consuming further attempts.                        |
| Icecast admin fetch    | 5 s per request                        | Applies to status polling and metadata updates. Status failures report unreachable Icecast and zero listeners.                       |
| Child-process shutdown | 5 s grace period                       | Send SIGTERM, then SIGKILL if the process has not exited. Both children are stopped in parallel.                                     |
| Zero-listener TTL      | 15 min (`STREAM_TTL_MINUTES`)          | Check immediately after startup, then every 60 s. Listeners reset the idle clock; `0` disables the watcher.                          |
| YouTube oEmbed fetch   | 5 s                                    | Best-effort metadata lookup after startup; failure does not stop audio.                                                              |
| Health probe           | 2 s per component                      | Probes run concurrently on each health request; a timeout makes the component `error`.                                               |

Poll deadlines are checked between fetches, so the in-flight request can extend a mount wait beyond its nominal budget. A start request may span multiple activation waits, mount-release waits, and process shutdowns; 30 s is **not** a total HTTP request deadline. The health monitor's 2 s stream probe can time out while `/api/state` waits on a 5 s Icecast fetch.

### 4.5 Failure and recovery matrix

Compose uses `restart: unless-stopped` for containers. This restarts crashed containers, not failed health probes or stopped child pipelines. Active URLs and pipeline state live only in memory; there is no automatic stream restoration after an application restart.

| Failure/event                                     | Result                                                                                                                                       | Recovery                                                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream container crashes or is recreated          | Child processes and in-memory state are lost; audio ends.                                                                                    | Docker restarts a crashed container, but the client must issue a new start request. An explicitly stopped container needs to be started by the operator.                                                                      |
| Streamlink/ffmpeg exits during startup            | The current attempt is torn down.                                                                                                            | Retry within the 3-attempt budget, advancing the proxy; failure to prepare the mount aborts retries. Exhausted attempts return `500`.                                                                                         |
| Proxy fails after startup or a finite source ends | A child exit stops the entire pipeline (`process-exit`).                                                                                     | No application-level reconnect; fix the cause if needed and start again.                                                                                                                                                      |
| Icecast is unavailable before startup             | Mount preparation fails; API returns `500`.                                                                                                  | Restore Icecast/connectivity or correct credentials, then retry the request.                                                                                                                                                  |
| Icecast crashes or restarts during playback       | Its mount and listener connections are lost. A child exit stops the pipeline; if children stay alive, zero-listener TTL eventually reaps it. | Docker can restart Icecast, but the application does not reconstruct the pipeline. Once Icecast is available, stop any lingering pipeline and start again. With TTL disabled, cleanup requires a process exit or manual stop. |
| Caddy is restarted/recreated                      | Public API and audio connections drop; internal pipeline can continue.                                                                       | Clients reconnect after Caddy returns. Restart audio through the API only if the pipeline has also stopped.                                                                                                                   |
| Health monitor is unavailable                     | External health checks fail; audio/control services are independent.                                                                         | Docker restarts a crashed monitor; inspect its logs if probes remain unavailable.                                                                                                                                             |
| Zero-listener TTL expires                         | Pipeline stops with reason `ttl`.                                                                                                            | Issue another start request when listening is needed.                                                                                                                                                                         |
| Replacement URL cannot start                      | The old pipeline has already stopped (`replaced`); failed replacement is torn down.                                                          | Correct the URL/proxy or explicitly request the previous URL again; there is no rollback to the previous stream.                                                                                                              |
| Metadata lookup/update fails                      | Audio continues; title metadata may be absent.                                                                                               | No pipeline recovery is needed; metadata is best-effort and has no application retry loop.                                                                                                                                    |

A healthy `/api/state` or `/hc` response does not mean audio is playing: an idle service with reachable Icecast is healthy. Use `general.state`, process status, and Icecast mount state from `/api/state` to distinguish readiness from playback.

### 4.6 Registry groundwork

`StreamRegistry` is an internal, separately tested owner of multiple `StreamPipeline` instances. It is not wired into `index.ts` or the HTTP server: the existing single-stream routes, replacement semantics, and health probe remain unchanged until API cutover.

- `create(videoId)` accepts an already validated video identity, constructs its canonical YouTube URL, and synchronously registers a cryptographically random UUID before asynchronous work. It allocates a distinct Icecast client at `/stream/<id>` and waits for mount preparation and pipeline readiness before resolving an immutable identity record. Each entry owns one pipeline, identified by its object reference rather than a separate numeric ID.
- `get(id)` and `findByVideoId(videoId)` read identity records without probing Icecast or awaiting startup/cleanup. These are internal lookups, not playback-readiness decisions or the final API listing/state models. Video identity is case-sensitive. Duplicate `create` calls currently reject while that video is registered or cleaning up; find-or-create reuse, startup joining, and waiting through teardown belong to the next coordination step.
- Each entry owns its pipeline, mount client, abort controller, startup promise, and shared cleanup promise. The pipeline still owns raw child processes, retries, derived phase, and its TTL watcher. Metadata, mount readiness, listener polling, and TTL are scoped to that entry's mount.
- Manual stop, TTL expiry, process exit, and failed startup hide the entry immediately. Cleanup stops its watcher and children, waits for raw startup to settle, and releases the temporary video exclusion only after cleanup succeeds. Failed cleanup is logged and keeps that internal exclusion; it never restores a public entry or permits a replacement generation prematurely. No stopped-stream history is retained.
- Pipeline startup accepts an optional abort signal. Checks around readiness and retry boundaries prevent removed generations from spawning another attempt or publishing late readiness. In-flight Icecast operations retain their existing timeouts; cancellation prevents subsequent work rather than interrupting those HTTP requests. Cleanup waits on raw startup, not the outer creation promise whose error handler joins cleanup.
- Late metadata results and stale exit/TTL callbacks are ignored once their entry has been removed. First removal owns teardown and terminal event accounting; subsequent callbacks do not produce duplicate outcomes. Registry, pipeline, and Icecast logs carry public `id` and `videoId`; lifecycle events carry only the public `id` plus a terminal reason or error when applicable. The announcement flag tracks event delivery only, not a stored pipeline phase.

There is no registry capacity limit or `MAX_STREAMS` configuration yet. Resource limits are configured independently (§7.5). HTTP listing/state schemas, request-level coordination, capacity accounting, and bootstrap replacement remain later delivery steps (§12.6).

---

## 5. Event bus

A small pub/sub bus carries outward stream lifecycle notifications. Both the bootstrapped `Stream` and the internal `StreamRegistry` emit the same ID-only contract. Lifecycle owners log full source context directly; `index.ts` no longer subscribes merely to reconstruct lifecycle logs. Internal concerns (process exits, TTL expiry) are observed directly via the per-pipeline `onExit`/`onExpired` callbacks, never through the bus. `onExit` fires only for exits the owner did not cause (owner kills stay silent).

| Event            | Emitted by        | Payload          |
| ---------------- | ----------------- | ---------------- |
| `stream:started` | Stream / registry | `{ id }`         |
| `stream:stopped` | Stream / registry | `{ id, reason }` |
| `stream:error`   | Stream / registry | `{ id, error }`  |

Event IDs are required, opaque UUIDs; payloads contain no YouTube URL, video ID, or internal pipeline ID. The existing `Stream` also assigns a UUID to each start attempt and preserves it across that generation's events; these IDs do not change its HTTP API or mountpoint. Consumers receive notifications by ID and must not query a removed entry merely to reconstruct logging context. Registry creation failures emit `stream:error`; other terminal causes emit `stream:stopped` once cleanup succeeds, including cancellation before a start was announced. Cleanup failures are logged without claiming a successful stop.

Every pipeline teardown declares its reason. Operational logging flows through the shared JSON logger: `Stream` and `StreamRegistry` log their own lifecycle transitions; collaborators report their own low-level facts directly (pipeline attempt starts, Icecast poll failures).

---

## 6. Health monitoring (#18)

A dedicated `health` container is an independent failure domain: it probes the components from the outside over plain HTTP and aggregates the result. It is the only service besides Caddy with a published host port.

- **Probes** (2 s timeout each, run concurrently):
  - `stream` → `GET stream:8080/api/state` (`Authorization: Bearer <API_KEY>`)
  - `icecast` → `GET icecast:8080/admin/stats` (basic auth, admin password)
  - `caddy` → `GET caddy:8089/hc` (Caddy's own static liveness route, internal-only)
- **Response:** `{ caddy, icecast, stream, version, commit }`; each component is `{ result: 'ok' | 'error', duration, error? }`, with duration in milliseconds. Version and commit identify the health monitor build. HTTP `503` when any component is `error`, otherwise `200` — the status code is the machine-readable verdict.
- A failing **or hanging** component never takes the monitor down: every probe wraps in try/catch with its own timeout.
- **Rate limited** — 60 requests/minute per client (`429` beyond, with `x-ratelimit-*` headers and `retry-after`); the `withRateLimit` wrapper guards `/hc` and `/health` (unknown paths are not counted). The store is capped at 5,000 clients with least-recently-used eviction, avoiding full-map scans. Evicted clients get a fresh allowance on their next request; expired windows reset when accessed.
- **Unauthenticated by decision** — external probers cannot send auth headers. The endpoint exposes component status only, no control surface.
- Host-resource checks (disk/memory) were considered and **descoped**: the monitor observes service components, not the machine.

---

## 7. Security design

### 7.1 API authentication

See §3.1. All `/api/*` endpoints require `API_KEY`, including `/api/state`. The health monitor receives the same key and sends it as a bearer token for its stream probe; `/hc` itself stays unauthenticated for external probers and exposes component status only.

### 7.2 SSRF guard

YouTube URL validation (`isValidYoutubeUrl`): only `youtube.com` / `youtu.be` hosts (optional `www.`), HTTP(S) schemes only; rejects IPs, credentials, and non-default ports. Accepted path forms and validation boundaries are documented in §3.3.

### 7.3 Listener limit

`ICECAST_MAX_LISTENERS` (default 2) is enforced independently per mount by Icecast alone — excess clients are rejected at connect time. A `<mount type="default">` policy supplies `<max-listeners>` for both `/stream` and dynamically named mounts without requiring per-ID configuration. It deliberately has no `<mount-name>`: Icecast 2.4 default policies apply to mounts without a matching normal block ([configuration reference](https://icecast.org/docs/icecast-2.4.1/config-file.html#mountsettings)).

Default policies do not merge with explicit normal mount blocks; adding such a block requires setting its listener cap explicitly. The existing container start command patches the default policy from `ICECAST_MAX_LISTENERS`; this setting never reaches the application. The listener cap is separate from Icecast's global client/source limits and the planned application stream cap.

### 7.4 Secrets hygiene

The API key is never logged (constant-time compare + URL redaction, see §3.1). Default credentials (`dev-api-key`, `secret`/`admin`) log startup warnings. Icecast passwords are patched into a tmpfs config copy at container start — the bind-mounted `icecast.xml` stays credential-free.

### 7.5 Container hardening

Every application container: non-root user, read-only root filesystem (tmpfs `/tmp` for scratch), `cap_drop: ALL`, `no-new-privileges: true`, resource limits (CPU/memory), log rotation (json-file, 10 MB × 3). Icecast runs as the image's own `icecast2` user (101:102): the root+sudo `/start.sh` entrypoint is bypassed (sudo needs `CAP_SETUID`), and the compose command patches credentials and `max-listeners` into a tmpfs copy of the config (`/etc/icecast2` stays intact — `/usr/share/icecast2` web/admin files symlink into it).

The stream container's memory and CPU limits are configurable through Compose-only `STREAM_MEMORY_LIMIT` (default `256M`) and `STREAM_CPU_LIMIT` (default `0.5`). Both source-built and release deployments use the same limits. Unset or empty values select the defaults; overrides use Compose's resource formats and are not passed into shared `Config` or the application environment. Limits cover Bun and its streamlink/ffmpeg children together, independently of stream-count capacity. Changing limits requires container recreation and interrupts active playback. Other containers retain their fixed limits; measured multi-stream sizing remains deferred to §12.4.

### 7.6 CI scanning

`bun audit` (gates on `critical`), gitleaks, GitHub **CodeQL** (default setup) for static analysis, **Dependabot** security updates for app-dependency CVEs, Dependabot version updates for Bun and GitHub Actions.

> **Decision — container-image Trivy scanning was dropped:** its advisory DB re-rates CVEs over time (revisions can flip findings between CRITICAL and HIGH), making a severity gate non-deterministic. CodeQL + Dependabot give reproducible code & app-dependency coverage instead. Docker ecosystem updates are deferred until E2E tests exist to validate a base-image bump.

Branch protection on `main` requires PR + passing CI.

---

## 8. Dependency pinning policy

All dependencies — bun packages, Docker base images, Docker service images, and system packages — are pinned to exact versions for reproducible builds. Without pinning, a rebuild months later can pull a newer dependency that introduces a breaking change, security regression, or behavior shift. Digests protect against tag mutation; exact versions protect against semver surprises.

| Layer                    | What                                     | How                                                                                     | Update cadence               |
| ------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
| **bun runtime deps**     | none (`yt-stream-shared` is a workspace) | `bun.lock` records resolved URL + integrity hash                                        | Dependabot (bun ecosystem)   |
| **Docker base image**    | `alpine:3.24`                            | Pinned by digest in `Dockerfile.bun`; Bun binary staged in from `oven/bun:1.4.2-alpine` | When bumping Bun or Alpine   |
| **Docker service image** | `moul/icecast`, `caddy:2-alpine`         | Pinned by digest in `docker-compose.yml`                                                | When bumping Icecast / Caddy |
| **apk packages**         | `ffmpeg`, `streamlink`                   | Exact version via compose build args                                                    | When bumping any package     |

Resolving digests and versions:

```bash
docker pull alpine:3.24
docker inspect alpine:3.24 --format='{{index .RepoDigests 0}}'
docker run --rm alpine:3.24 apk info -a ffmpeg streamlink
```

---

## 9. Logging

Every service logs to stdout/stderr → `docker logs`. Logs are pino-shaped JSON (numeric level, `pid`/`hostname`, `msg`), level via `LOG_LEVEL`, from a small built-in logger shared by both services. Caddy and Icecast log to their own stderr (access log off). The json-file driver with rotation (10 MB × 3) is set on all compose services; `docker compose logs --timestamps` shows unified UTC stamps.

---

## 10. Testing, linting & CI

- **Unit tests** — `bun test`, all suites on `bun:test` (`server.fetch`/real sockets, `spyOn`, `vi.fn`, `mock.module`). Real processes where sensible (the `ChildProcess` one-shot wrapper is tested against real processes). Coverage: process lifecycle and kill fallbacks, wrapper spawn args, `ProxyList` (optional-file loading with degradation, request-scoped rotation), Icecast admin client, pipeline orchestration (attempts + fresh pairs, readiness polling, fail-fast attribution, TTL), Stream orchestration (replace/stop/failure accounting, event emission, health snapshot), auth (header/query/missing/invalid), route status codes, health probes and aggregation, shared `Config` defaults/overrides/immutability, SSRF cases, oEmbed metadata.
- **Linting & formatting** — `oxlint` + `oxfmt`, configured once at the repo root; every workspace exposes `lint` / `format` / `format:check` scripts.
- **CI** — lint + format-check + tests on every PR open/update; dependency & secret scanning (§7.6); merge blocked on failure via branch protection.

---

## 11. Recorded decisions log

| #   | Decision                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | streamlink replaces yt-dlp for stream extraction (2026-08)                     | streamlink's HLS client keeps up with YouTube's 30 s live window; bare ffmpeg/yt-dlp could not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | No explicit state machine — sequential `async/await`, derived phase            | The PoC state machine duplicated information the processes already expose; derived phase cannot drift from reality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3   | Event bus carries only outward `stream:*` notifications                        | Internal concerns observed directly per pipeline; the bus stays a thin logging seam, not an orchestration mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | API moved under `/api/` prefix                                                 | Avoids the collision between the `/stream` management route and the `/stream` audio mount                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Caddy is the only public door; `handle` blocks everywhere                      | Mixed path-matched directives reorder under Caddy's directive ordering — see the warning in §2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6   | Dedicated `health` container, published on its own port (#18)                  | Independent failure domain; external probers cannot send auth headers; a wedged component cannot take the monitor down                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 7   | `/api/state` requires `API_KEY` (#58)                                          | Keep the whole `/api/*` namespace consistently protected; the health monitor uses bearer auth for its stream probe — see §7.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 8   | Internal ports fixed at 8080 (all services) + Caddy liveness on 8089           | Per-container namespaces make them collision-free; only host-published ports need configuring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 9   | Trivy image scanning dropped from CI                                           | Advisory DB re-rates CVEs over time → non-deterministic severity gate (§7.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 10  | Bun-workspaces monorepo, `yt-stream-shared` Config                             | Two services, one env contract — no drift between copies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 11  | Proxies: random pick per start, from a JSON list                               | Residential IPs are required to pass YouTube's bot checks; rotation spreads rate-limit exposure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 12  | `PROXY_FILE` is host-side only; in-container path fixed (#35)                  | Compose mounts `${PROXY_FILE:-./proxy.json}` with `create_host_path: false` — the mount is the knob; a missing file fails `up` loudly instead of silently creating a directory; the app reads exactly `/app/proxy.json`, no cwd-relative fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13  | Start attempts rotate proxies; failures log the proxy (#35)                    | Attempts draw from a per-request shuffled rotation — a poisoned exit is never retried through itself; per-attempt redacted-proxy logs make bad exits diagnosable in one line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 14  | `ProxyList` owns file→pool; rotation is a per-request iterator                 | Only the stream consumes proxies, and only it has a logger at load time — load problems warn and degrade to a direct connection; rotation state lives in the iterator, so interleaved starts cannot corrupt each other                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 15  | `socks5`/`socks5h` proxy schemes accepted (#35 follow-up)                      | streamlink delegates to requests; PySocks ships with the Alpine streamlink package (verified in-image); `socks5h` resolves DNS at the exit — preferred for residential providers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 16  | Process wrappers are one-shot: one instance = one process                      | The host model emulated process identity inside a longer-lived object (kill-mark graveyard, null-proc tri-state, replace-on-spawn). One-shot instances make identity real; retries construct fresh pairs; `spawn`/`onExit` chain, `kill` stays a promise                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 17  | `StreamPipeline` lives in its own module                                       | Each layer gets its own test seam: the pipeline is tested against mocked wrappers/Icecast, `Stream` against a fake pipeline — instead of both through one facade                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 18  | TLS: provided certs via file mounts + `--force-recreate`; ACME otherwise (#34) | Non-standard host ports can never pass ACME's fixed `:80`/`:443` challenges, so pre-existing pairs must be usable on any ports while auto-HTTPS/HTTP-only stay untouched. Mode is chosen once at container start — a wrapper writes the `tls` snippet the Caddyfile imports (no Caddyfile conditionals; a missing pair must not be fatal). **File** mounts (not a dir) let Docker resolve certbot's `live/` symlinks at creation; the resolution is pinned per container and Caddy never re-reads file certs in-process ([caddy#5139](https://github.com/caddyserver/caddy/issues/5139)) — so renewal = recreate the container (certbot deploy hook), accepting a brief listener drop over a copy+`caddy reload` pipeline |

---

## 12. Multi-stream contract (#7)

This is the target contract for [#7](https://github.com/RomiC/yt-stream/issues/7), not a description of currently available endpoints. Implementation is split into reviewable steps; all implementation PRs target `feat/multi-stream-7` before integration into `main`.

### 12.1 API and input identity

| Method   | Path                      | Behavior                                                               |
| -------- | ------------------------- | ---------------------------------------------------------------------- |
| `GET`    | `/api/streams`            | List starting and streaming entries, including their IDs and phases    |
| `GET`    | `/api/streams?url=…`      | Find-or-create by YouTube video identity; `302` to ready audio         |
| `GET`    | `/api/streams?video_id=…` | Same find-or-create behavior using a YouTube video ID                  |
| `GET`    | `/api/streams/:id`        | `302` to a ready, live stream; otherwise `404`; never creates a stream |
| `GET`    | `/api/streams/:id/state`  | Per-stream state and health; `404` after public removal                |
| `DELETE` | `/api/streams/:id`        | Remove publicly, stop owned work, await cleanup, then return `204`     |
| `GET`    | `/stream/:id`             | Public Icecast audio mount                                             |

There is no POST creation endpoint, collection-wide DELETE, default stream, or replacement of another video. GET creation intentionally preserves start-and-play links for redirect-following players. With query authentication enabled, both `/api/streams?url=<encoded-youtube-url>&key=<key>` and `/api/streams?video_id=r_SV26dPwuA&key=<key>` are directly playable links.

All supported `/api/*` endpoints retain the authentication rules in §3.1, including authentication before input validation. Audio mounts remain public. Every API response, including errors and redirects, uses `Cache-Control: no-store`; cache reuse must not skip creation or replay an obsolete redirect. Redirects use a relative `Location: /stream/<id>` and do not forward the API key to the audio URL.

Source identity and validation:

- Public stream IDs are generated with built-in `crypto.randomUUID()`. They are opaque, case-sensitive lookup keys, not YouTube IDs or sequential counters. Randomness reduces guessing, not the need for authentication.
- Deduplicate by the case-sensitive YouTube video ID. Each entry owns exactly one pipeline; compare entry/pipeline object references to guard delayed callbacks, without a separate generation ID. A newly created entry receives a new public ID, including after stopping and restarting the same video.
- Exactly one of `url` or `video_id` selects find-or-create. Supplying both, repeated source parameters, or an empty supplied value is `400`; only absence of both selects listing. Authentication parameters do not select creation.
- For full URLs, call the boolean validator `isValidYoutubeUrl` once, then call `getYoutubeVideoId` only after validation succeeds. The extractor does not validate, and its result is not revalidated. Bare `video_id` inputs are validated independently. Both forms require exactly 11 characters from `[A-Za-z0-9_-]`; video existence and extractability are not checked.
- Source resolution returns only the video ID (or `null` for listing). Construct the pipeline and metadata URL as `https://www.youtube.com/watch?v=<video_id>` at the pipeline integration boundary. Tracking parameters, timestamps (`t`, `start`), playlist parameters, and fragments are ignored, not passed through. There is no per-request offset, playlist, or quality selection. Equivalent accepted URLs always share one stream.
- Validation checks syntax, not existence or extractability; extraction and finite-source behavior remain as described in §3.3.

### 12.2 Response schemas and health

Every API response carries the serving application's release metadata in `X-Service-Version` and `X-Service-Commit` headers, including redirects, empty `204` responses, authentication failures, and other errors. Every JSON API response also includes root `version` and `commit` fields with matching values. Use the existing release-metadata source and its development fallbacks (`dev` / `unknown`); do not add bodies to redirects or `204` responses just to carry metadata.

`GET /api/streams` returns `200` without awaiting any startup or teardown promise:

```json
{
  "streams": [{ "id": "a7ad2e11-46d3-4b56-bcfa-cc8e673d7842", "video_id": "r_SV26dPwuA", "state": "streaming" }],
  "max_streams": 3,
  "version": "dev",
  "commit": "unknown"
}
```

Each list item contains only `id`, `video_id`, and `state` (`starting` or `streaming`); detailed process, mount, and listener information belongs to the state endpoint. Use `streams.length` for the number of public entries; `max_streams` is the configured cap. Ordering is not an API guarantee. Internal capacity usage can exceed `streams.length` during cleanup, so the list length does not guarantee that a new stream can start. All values describe one registry snapshot.

`GET /api/streams/:id/state` returns the per-stream snapshot with `state` at the root and no `general` object:

```json
{
  "id": "a7ad2e11-46d3-4b56-bcfa-cc8e673d7842",
  "video_id": "r_SV26dPwuA",
  "started_at": "2026-08-01T12:00:00.000Z",
  "state": "streaming",
  "streamlink": { "status": "running" },
  "ffmpeg": { "status": "running" },
  "icecast": { "status": "available", "state": "streaming", "listeners": 1 },
  "version": "dev",
  "commit": "unknown"
}
```

- `started_at` is the readiness-confirmation time in UTC ISO 8601, or `null` while starting. Root `state` is only `starting` or `streaming`; there is no public stopped-state resource.
- Process and Icecast field values retain their definitions from §4.1. A retrying startup may temporarily have stopped child processes or an inactive mount without being a failed stream.
- Health is `ok` when Icecast is reachable and either the entry is starting, or both children are running and its mount is active. Otherwise it is `failure`. Return `200` for `ok`, `503` for `failure`; the verdict is conveyed by HTTP status, not a separate per-stream response field.
- Initial readiness remains distinct from a current mount probe: a live, previously ready pipeline can have root `state: streaming` but unhealthy Icecast. Playback redirects use confirmed readiness and current process liveness, not an additional synchronous admin probe.
- If an entry is removed while a state probe is in flight, return `404` instead of publishing a stopped snapshot or another generation's data.

There is no aggregate `/api/state` endpoint. The health service checks the stream application with authenticated `GET stream:8080/api/streams`, with no source query parameters, and treats a non-2xx response as failure.

- Listing checks application/API availability, not the health of each pipeline. It returns `200` for a successful authenticated snapshot even when the registry is empty, full, starting, or cleaning up. It does not probe Icecast or await lifecycle operations.
- The health service's existing separate Icecast probe checks the one shared Icecast server; mount-specific clients do not represent separate servers. Its Caddy probe remains unchanged.
- Per-stream process/mount diagnostics remain at `/api/streams/:id/state`. A failed stream is removed and recorded in logs, not retained as a service-health failure.
- The health service retains its existing timeouts, aggregation, status codes, and rate limiting; only its stream-check URL changes.

### 12.3 Concurrency and lifecycle

The registry owns entries and lifecycle coordination; each `StreamPipeline` continues owning its processes, retry attempts, readiness, and TTL watcher. No new stored pipeline state machine is required.

| Situation                            | Behavior                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Same video already streaming         | Immediate `302` to its existing mount, without restarting                             |
| Same video starting                  | Join its startup promise; redirect only after readiness                               |
| Different video requested            | Start independently if capacity permits                                               |
| List/state requested during startup  | Read the snapshot without waiting for startup                                         |
| DELETE during startup                | Hide the entry, cancel startup, await cleanup; joined creation requests receive `409` |
| Same video requested during teardown | Wait for that video's cleanup, then retry find-or-create/capacity checks              |

Register video identity, public identity, startup coordination, and the capacity reservation before asynchronous startup work. Joining requests share the outcome, not one consumable HTTP `Response`. Client disconnects do not cancel shared startup; explicit deletion cancels it, and zero listeners are handled by TTL after successful startup. Cancellation prevents subsequent retry attempts or late readiness from resurrecting an entry.

For every terminal cause (`manual`, `ttl`, `process-exit`, or `start-failed`):

1. Hide the entry from public lookup/listing immediately; playback and state reads return `404`.
2. Stop the TTL watcher and terminate/await owned children. Concurrent delete, TTL, and exit callbacks share one teardown operation.
3. Retain only temporary internal coordination needed for cleanup, same-video exclusion, and capacity accounting. Remove those references when cleanup finishes.
4. Release the reservation only after both processes have exited; if teardown fails, keep the reservation until cleanup can be confirmed and log the failure.
5. Log the terminal outcome with public ID, video ID, reason, and relevant process/error attribution. Account for the terminal lifecycle outcome exactly once; failed starts never emit `stream:started`.

Metadata callbacks, process exits, and TTL expiry operate on their owning generation and mount. They cannot remove or update a later entry for the same video, or another video. A stopped entry is never archived in the registry; logs, subject to existing rotation, are the historical record. Restart/recreation restores no streams or IDs automatically.

### 12.4 Capacity and deployment resources

`MAX_STREAMS` is a positive base-10 integer, default `1`. Invalid, zero, negative, or fractional values fail configuration at startup rather than silently falling back. It limits starting, streaming, and still-cleaning-up pipelines together. Reserve before process spawn; release only after confirmed cleanup. Reusing an existing streaming/starting entry requires no additional slot, even at capacity. New streams at capacity receive `503`; there is no implicit eviction or global operation-in-progress `429`.

Stream-container resource limits are already configurable in Compose (§7.5); `MAX_STREAMS` remains a target application setting for the capacity step. These settings are independent:

| Setting                 | Default | Owner                                               |
| ----------------------- | ------- | --------------------------------------------------- |
| `MAX_STREAMS`           | `1`     | Shared application `Config`, passed through Compose |
| `STREAM_MEMORY_LIMIT`   | `256M`  | Compose memory limit                                |
| `STREAM_CPU_LIMIT`      | `0.5`   | Compose CPU limit                                   |
| `STREAM_TTL_MINUTES`    | `15`    | Existing setting, applied per pipeline              |
| `ICECAST_MAX_LISTENERS` | `2`     | Icecast limit, applied per dynamic mount            |

Raising `MAX_STREAMS` requires explicit operator sizing; memory is not automatically multiplied by stream count. Measure shared Bun overhead, per-pipeline memory/CPU, buffers, simultaneous startup peaks, and available headroom. Account for Icecast resource/source limits and proxy bandwidth too. Icecast's source cap must be at least `MAX_STREAMS`. An OOM kill of the shared stream container can interrupt every pipeline.

For example, `MAX_STREAMS=3`, `STREAM_MEMORY_LIMIT=1G`, and `STREAM_CPU_LIMIT=1.0` are illustrative settings, not a measured guarantee. Tested profiles for 1, 2, and 3 streams, including simultaneous starts, belong to the final sizing step.

### 12.5 Errors and cancellation

Extend the existing JSON error envelope with release metadata: `{ "status": <http-status>, "error": <message>, "version": <version>, "commit": <commit> }`. The metadata headers from §12.2 apply to errors too. Redacted diagnostic `details` may accompany startup/internal failures; API keys and proxy/source credentials must never be returned or logged unredacted.

| Request/outcome                                       | Status | Error or response                                                              |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| Missing/invalid API key                               | `401`  | Existing authentication error                                                  |
| Invalid, empty, repeated, or conflicting source input | `400`  | Validation error identifying the invalid source parameter(s)                   |
| New source when capacity is exhausted                 | `503`  | `Stream capacity reached`                                                      |
| Startup/extraction/readiness failure                  | `500`  | `Failed to start stream`; all joined requests receive the same failure outcome |
| Startup explicitly cancelled by DELETE                | `409`  | `Stream startup cancelled`; applies to creation requests awaiting that startup |
| Unknown/removed ID for state or DELETE                | `404`  | `Stream not found`                                                             |
| Playback by unknown, removed, or not-yet-ready ID     | `404`  | `Stream not active`                                                            |
| Successful DELETE after cleanup                       | `204`  | Empty body                                                                     |
| Teardown/internal operation fails                     | `500`  | `Internal Server Error`; cleanup reservation is not released prematurely       |
| Unsupported method on an existing API route           | `405`  | Include `Allow` for that route; no POST fallback                               |

Only the first DELETE that finds the entry initiates teardown and waits for it. Because public removal is immediate, later/concurrent DELETEs receive `404`; they do not emit duplicate terminal events. A successful DELETE means child processes have exited, not that historical state is retained. The health monitor's independent rate limiting and its `429` responses remain unchanged.

### 12.6 Migration and delivery

This is a breaking API cutover, with no singular-route compatibility alias:

- `/api/stream` (GET and DELETE) is removed and returns `404`; clients change their start-and-play links to `/api/streams`.
- Direct `/stream` playback is removed and returns `404`. Players follow the creation redirect to `/stream/<id>`, or use `/api/streams/:id` while that entry is active.
- There is no default stream, no arbitrary first-map-entry alias, and no collection-wide stop operation.
- `/api/state` is removed and returns `404`. The health service moves its authenticated stream check to `/api/streams`; clients needing pipeline/mount state use `/api/streams/:id/state`.
- IDs and registry contents are ephemeral. After a stop or application restart, an old playback/state ID returns `404`; starting again allocates a fresh ID.

The integration branch is `feat/multi-stream-7`. Topic branches start from it and PRs target it, not `main`. The delivery sequence is:

1. Finalize this API/lifecycle contract.
2. Normalize YouTube source inputs.
3. Parameterize Icecast mountpoints.
4. Enable dynamic audio routing and listener limits.
5. Configure stream-container resource limits.
6. Introduce the registry and isolated lifecycle/removal/logging.
7. Add per-video startup/teardown coordination.
8. Enforce capacity accounting and rejection.
9. Implement listing and per-stream state models.
10. Wire plural GET APIs, bootstrap cutover, health-probe migration, and legacy-route removal.
11. Wire per-stream DELETE.
12. Verify end-to-end multi-stream behavior.
13. Measure resource sizing and finish operator guidance.

Preparatory work remains testable against the existing orchestration; default mountpoint behavior can remain until the API cutover. Each step includes focused tests and relevant design updates. Persistence, per-user ownership, automatic eviction, and new crash-recovery behavior are out of scope.
