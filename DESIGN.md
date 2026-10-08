# yt-stream — Design

A self-hosted service that converts a YouTube live stream or video into an Icecast-compatible MP3 audio stream. A single `GET /api/stream?url=…` request starts the pipeline and redirects to the audio mountpoint. Exactly **one stream** runs at a time; starting a new URL replaces the current one.

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
 HEALTH_PORT│                              │──── /stream ▶ icecast :8080 (internal)
            │  health :8080 (published)    │
            └──────────────────────────────┘
             caddy liveness :8089 (internal only)
```

- **caddy** — reverse proxy, the only public door. TLS when `PUBLIC_BASE_URL` is `https://…`: automatic HTTPS (Let's Encrypt) by default, or operator-provided certificates (§2); HTTP-only mode for local dev. Also exposes a static liveness route on an internal-only port.
- **stream** — Bun application: URL validation, the `streamlink → ffmpeg` pipeline, Icecast admin polling, TTL auto-stop, metadata push. Internal port only.
- **icecast** — off-the-shelf streaming server (`moul/icecast`, digest-pinned). Single fixed mountpoint `/stream`; serves audio to listeners and an admin API to the internal network.
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
│   ├── icecastClient.ts        # Icecast admin-API client: getStatus, sourceUrl, streamUrl, mount-clear readiness
│   ├── statusReport.ts         # /api/state snapshot + ok/failure verdict
│   ├── status.ts               # stream/probe status types
│   ├── streamPipeline.ts       # one stream generation: fresh streamlink/ffmpeg pair per attempt, readiness, TTL
│   ├── stream.ts               # orchestration: replace/stop pipelines, event accounting, health snapshot
│   ├── ttlWatcher.ts           # zero-listener TTL: polls Icecast, notifies owner via onExpired
│   ├── withAuth.ts             # API-key validation decorator
│   ├── withLock.ts             # single-operation concurrency lock (429)
│   ├── withLogging.ts        # request-logging decorator (redacts ?key=)
│   ├── server.ts               # Bun.serve: routes /api/stream + /api/state
│   ├── utils/
│   │   ├── isValidYoutubeUrl.ts  # SSRF-guard URL validation
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
	handle /stream {
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

Everything except `/api/*` and `/stream` returns 404 externally. Icecast's `/admin/*`, `/status.xsl`, and `/` are unreachable from outside the Docker network.

---

## 3. Public API & authentication

| Method   | Path                                     | Auth | Purpose                                       |
| -------- | ---------------------------------------- | ---- | --------------------------------------------- |
| `GET`    | `/api/stream?url=…`                      | ✅   | Start a stream; `302` redirect to audio mount |
| `DELETE` | `/api/stream`                            | ✅   | Stop the current stream                       |
| `GET`    | `/api/state`                             | ✅   | Service state + health verdict (JSON)         |
| `GET`    | `/stream`                                | —    | Audio mount (Icecast, public)                 |
| `GET`    | `/hc` (alias `/health`) on `HEALTH_PORT` | —    | Aggregated component health                   |

### 3.1 Authentication

- `API_KEY` env var (dev fallback `dev-api-key` with a startup warning).
- **Dual mode:** `Authorization: Bearer <key>` header, or `?key=<key>` query param enabled only when `ALLOW_KEY_IN_QUERY=true`. Query-key authentication enables a single start-and-play URL that can be pasted directly into a player without custom headers: `/api/stream?key=<key>&url=<encoded-youtube-url>` starts the stream and redirects to the public audio mount.
- Enable query authentication for that player-link workflow; otherwise leave it disabled (the default) or turn it off. Such links carry the API key and can leak through player/browser history or Caddy's error log; treat them as credentials. The player must follow HTTP redirects.
- Comparison is constant-time (`timingSafeEqual`). The `withLogging` decorator uses `redactApiKey` to scrub the `key` param from logged URLs — the redactor matches the _decoded_ param name, so percent-encoding (`?k%65y=`) cannot smuggle the key into logs.
- Applies to all `/api/*` endpoints, including `/api/state`.
- The `/stream` audio mount is **not** key-protected: radio receivers cannot send headers.

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

`isValidYoutubeUrl` accepts these HTTP(S) URL prefixes, with an optional `www.` host prefix and a non-empty ID containing letters, digits, underscores, or hyphens:

| URL form   | Example                                |
| ---------- | -------------------------------------- |
| Watch      | `https://www.youtube.com/watch?v=<id>` |
| Live       | `https://youtube.com/live/<id>`        |
| Shorts     | `https://youtube.com/shorts/<id>`      |
| Short link | `https://youtu.be/<id>`                |

The validator checks a prefix, not video existence, access rights, or full trailing query syntax. For watch URLs, `v` must be the first query parameter; channel/playlist URLs and other hostnames such as `m.youtube.com` do not match. Credentials, IP hosts, explicit ports (including standard ports), and non-HTTP(S) schemes are rejected. Encode the complete YouTube URL as the API's `url` parameter to preserve any `&` characters.

URL acceptance does **not** guarantee extraction: the pinned streamlink YouTube plugin must find a playable stream using `STREAMLINK_QUALITY` (default `audio_only,worst`), and YouTube must allow access from the selected exit IP. There is no application-level cookies/login configuration for restricted sources. The API does not distinguish live from finite sources: it runs whatever streamlink extracts. A finite source ending cleanly stops the pipeline with `process-exit`, just like another child-process exit; it does not loop or resume.

The URL forms and lifecycle handling are covered by unit tests; automated end-to-end extraction against real YouTube live streams and finite videos is not currently covered. The Compose stack also pins Icecast to `linux/amd64`; an ARM host needs amd64 emulation support.

---

## 4. Stream lifecycle

### 4.1 No state machine

There is no explicit state machine. Each generation is a `StreamPipeline` that owns the TTL watcher, the `IcecastClient`, and the current streamlink/ffmpeg pair — a **fresh pair per start attempt**: a wrapper instance mirrors exactly one process, so a retry constructs new instances. `Stream` keeps a map of live pipelines (`#pipelines`, keyed by id — a stepping stone to a future multi-stream design) and a `#currentPipeline` pointer to the active one. The pipeline's phase is **derived, not stored** — process liveness plus a readiness flag set once mount activation succeeds:

- `starting` — processes alive, startup readiness not yet confirmed
- `streaming` — processes alive, startup readiness confirmed
- `stopped` — either process dead

The readiness flag is not continuously refreshed. `/api/state` separately probes the current Icecast mount, so `general.state: streaming` can coexist with an unavailable or stopped mount and a `failure` health verdict.

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

---

## 5. Event bus

A small pub/sub bus carries the outward stream lifecycle notifications. `Stream` is the only emitter; `index.ts` (logging) the only consumer. Internal concerns (process exits, TTL expiry) are observed directly via the per-pipeline `onExit`/`onExpired` callbacks, never through the bus. `onExit` fires only for exits the owner did not cause (owner kills stay silent).

| Event            | Emitted by | Consumed by | Payload                                                      |
| ---------------- | ---------- | ----------- | ------------------------------------------------------------ |
| `stream:started` | stream     | logging     | `{ url }`                                                    |
| `stream:stopped` | stream     | logging     | `{ url, reason: manual \| replaced \| process-exit \| ttl }` |
| `stream:error`   | stream     | logging     | `{ url, error }`                                             |

Every pipeline teardown declares its reason. Operational logging flows through the shared JSON logger: `Stream` reports lifecycle transitions; collaborators report their own low-level facts directly (pipeline attempt starts, Icecast poll failures).

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

YouTube URL-prefix validation (`isValidYoutubeUrl`): only `youtube.com` / `youtu.be` hosts (optional `www.`), HTTP(S) schemes only; rejects IPs, `@` userinfo tricks, and explicit ports. Accepted path forms and validation boundaries are documented in §3.3.

### 7.3 Listener limit

`ICECAST_MAX_LISTENERS` (default 2) is enforced by Icecast alone (`<max-listeners>` per mount — excess clients rejected at connect time). The cap is injected into the Icecast config by its container's start command and never reaches the application.

### 7.4 Secrets hygiene

The API key is never logged (constant-time compare + URL redaction, see §3.1). Default credentials (`dev-api-key`, `secret`/`admin`) log startup warnings. Icecast passwords are patched into a tmpfs config copy at container start — the bind-mounted `icecast.xml` stays credential-free.

### 7.5 Container hardening

Every application container: non-root user, read-only root filesystem (tmpfs `/tmp` for scratch), `cap_drop: ALL`, `no-new-privileges: true`, resource limits (CPU/memory), log rotation (json-file, 10 MB × 3). Icecast runs as the image's own `icecast2` user (101:102): the root+sudo `/start.sh` entrypoint is bypassed (sudo needs `CAP_SETUID`), and the compose command patches credentials and `max-listeners` into a tmpfs copy of the config (`/etc/icecast2` stays intact — `/usr/share/icecast2` web/admin files symlink into it).

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
