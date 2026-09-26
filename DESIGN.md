# yt-stream — Design

A self-hosted service that converts a YouTube live stream or video into an Icecast-compatible MP3 audio stream. A single `GET /api/stream?url=…` request starts the pipeline and redirects to the audio mountpoint. Exactly **one stream** runs at a time; starting a new URL replaces the current one.

### Guiding principles

- **Single entry point** — the application is reachable only through Caddy (one public URL); the health monitor is the single deliberate exception, published on its own port.
- **Convenience preserved** — a client can start and tune into a stream with a single `GET` request.
- **Minimal dependencies** — Node built-ins where possible; only battle-tested external components (Fastify, streamlink, ffmpeg, Icecast, Caddy).
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

- **caddy** — reverse proxy, the only public door. Automatic HTTPS (Let's Encrypt) when `PUBLIC_BASE_URL` is `https://…`; HTTP-only mode for local dev. Also exposes a static liveness route on an internal-only port.
- **stream** — Node.js application: URL validation, the `streamlink → ffmpeg` pipeline, Icecast admin polling, TTL auto-stop, metadata push. Internal port only.
- **icecast** — off-the-shelf streaming server (`moul/icecast`, digest-pinned). Single fixed mountpoint `/stream`; serves audio to listeners and an admin API to the internal network.
- **health** — independent failure domain (#18). Probes the three components from the outside over plain HTTP and aggregates the result.

### Package layout (npm workspaces)

```
packages/
├── shared/                     # yt-stream-shared — env Config shared by all services
│   ├── lib/config.js           #   immutable env config (constructor takes an env object)
│   └── index.js                #   public exports
├── stream/src/
│   ├── events.js               # event bus + exported Event map (stream:* notifications)
│   ├── childProcess.js         # one-shot wrapper: one instance = one process (spawn/kill/exit payload)
│   ├── streamlink.js           # streamlink process: fetch the stream
│   ├── proxyList.js            # ProxyList entity: optional file → pool (warn+degrade), request-scoped rotation
│   ├── ffmpeg.js               # ffmpeg process: transcode stdin → Icecast output URL
│   ├── icecastClient.js        # Icecast admin-API client: getStatus, sourceUrl, streamUrl, mount-clear readiness
│   ├── statusReport.js         # /api/state snapshot + ok/failure verdict
│   ├── streamPipeline.js       # one stream generation: fresh streamlink/ffmpeg pair per attempt, readiness, TTL
│   ├── stream.js               # orchestration: replace/stop pipelines, event accounting, health snapshot
│   ├── ttlWatcher.js           # zero-listener TTL: polls Icecast, notifies owner via onExpired
│   ├── auth.js                 # API key validation (Fastify hook; exempts /api/state)
│   ├── routes.js               # HTTP handlers
│   ├── utils/
│   │   ├── isValidYoutubeUrl.js  # SSRF-guard URL validation
│   │   ├── redactProxy.js        # strip proxy credentials for logging
│   │   └── getYoutubeMeta.js     # YouTube oEmbed metadata
│   └── index.js                # bootstrap
├── health/src/
│   ├── check.js                # base class: timed check envelope (result / duration / error)
│   ├── streamCheck.js          # GET stream:8080/api/state
│   ├── icecastCheck.js         # GET icecast:8080/admin/stats (basic auth)
│   ├── caddyCheck.js           # GET caddy:8089/hc — Caddy's own liveness route
│   ├── config.js               # check constants (timeout, rate limit)
│   ├── app.js                  # Fastify app factory (rate limiter registered before routes)
│   ├── routes.js               # /hc + /health aggregation
│   └── index.js                # bootstrap
├── caddy/Caddyfile
├── icecast/icecast.xml
└── Dockerfile.node             # shared build for stream & health (SERVICE build arg)
```

Tests mirror each package's `src/` tree under `tests/`.

---

## 2. Network & port model

- **Caddy** is the application's entry point (host ports `HTTP_PORT`/`HTTPS_PORT`, default 80/443).
- The **health** monitor is published separately on `HEALTH_PORT` (default 8080) — the only other exposed surface, by decision.
- `stream` and `icecast` bind **only** on the internal Docker network — no published host ports.

Container-internal ports are **fixed, not configurable**: stream, icecast and health all listen on 8080 (per-container network namespaces — no conflict); Caddy's liveness route lives on 8089. Only host-published ports are env-configurable.

### Caddy routing

```
{$PUBLIC_BASE_URL} {
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

Everything except `/api/*` and `/stream` returns 404 externally. Icecast's `/admin/*`, `/status.xsl`, and `/` are unreachable from outside the Docker network.

---

## 3. Public API & authentication

| Method   | Path                                     | Auth | Purpose                                       |
| -------- | ---------------------------------------- | ---- | --------------------------------------------- |
| `GET`    | `/api/stream?url=…`                      | ✅   | Start a stream; `302` redirect to audio mount |
| `DELETE` | `/api/stream`                            | ✅   | Stop the current stream                       |
| `GET`    | `/api/state`                             | —    | Service state + health verdict (JSON)         |
| `GET`    | `/stream`                                | —    | Audio mount (Icecast, public)                 |
| `GET`    | `/hc` (alias `/health`) on `HEALTH_PORT` | —    | Aggregated component health                   |

### 3.1 Authentication

- `API_KEY` env var (dev fallback `dev-api-key` with a startup warning).
- **Dual mode:** `Authorization: Bearer <key>` header, or `?key=<key>` query param enabled only when `ALLOW_KEY_IN_QUERY=true` (query keys can leak into Caddy's error log and browser history — keep it off).
- Comparison is constant-time (`timingSafeEqual`). Pino redaction scrubs the `key` param from logged URLs — the redactor matches the *decoded* param name, so percent-encoding (`?k%65y=`) cannot smuggle the key into logs.
- Applies to all `/api/*` endpoints **except `/api/state`** — see the decision log.
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

One in-flight operation at a time: the route holds a `requestInProgress` flag; concurrent start/delete requests are dropped with `429`. `GET /api/stream` without a `url` returns `400` — the endpoint is start-only; status is served by `/api/state`. Requesting the **same URL** while it is already streaming is idempotent — an immediate `302` without restarting the pipeline.

---

## 4. Stream lifecycle

### 4.1 No state machine

There is no explicit state machine. Each generation is a `StreamPipeline` that owns the TTL watcher, the `IcecastClient`, and the current streamlink/ffmpeg pair — a **fresh pair per start attempt**: a wrapper instance mirrors exactly one process, so a retry constructs new instances. `Stream` keeps a map of live pipelines (`#pipelines`, keyed by id — a stepping stone to a future multi-stream design) and a `#currentPipeline` pointer to the active one. The pipeline's phase is **derived, not stored** — process liveness plus Icecast mount readiness:

- `starting` — processes alive, mount not yet active
- `streaming` — processes alive, mount active
- `stopped` — either process dead

### 4.2 Start sequence

`start(url)` runs strictly sequentially with `async/await`:

1. If the same URL is already streaming — return immediately (idempotent).
2. Stop any existing pipeline — the TTL watcher first, then both processes killed in parallel and awaited (the old stream ends with reason `replaced` **before** the new start is attempted, so a failed replacement cannot leave it unaccounted for).
3. `prepareMountPoint()` — Icecast reachable and the mount free (old source released).
4. The pipeline draws the proxy from a per-request `ProxyList` rotation: a fresh shuffle per start, attempts advance without repeating (reshuffling once exhausted). An empty pool means direct connection — the optional file's absence or malformation warns but never blocks startup.
5. Spawn streamlink + ffmpeg, pipe them, then wait for the Icecast mount to become active (30 s budget, 500 ms poll interval) — proof the pipeline works end-to-end. A failed attempt is retried up to 3 times: both processes are torn down and the pipeline **advances to the next pool entry** (a poisoned exit is never retried through itself). Each attempt logs the redacted proxy.
6. Fail fast when a process exits before the mount is active (attributed with its exit code/signal and stderr tail); a timeout also fails the attempt. Exhausted attempts fail the request (the failure log carries the last proxy); any other step throwing maps to `500` — no retries outside the start-attempt loop.
7. On success: start the TTL watcher, fetch YouTube oEmbed metadata and push `<author> - <title>` to Icecast (best-effort — unavailable metadata never fails the stream), emit `stream:started`.

A failed start tears the failed pipeline down and emits `stream:error` (it never emitted `stream:started`).

### 4.3 Failure semantics & auto-stop

- **Process wrappers are one-shot** — each instance mirrors exactly one process: constructed, spawned once, running, exited (terminal); a second spawn throws. The owner marks a kill *before* signaling, so its close is silent; every other exit — including a clean `code: 0` end of a finite source — reaches `onExit` with `{ cmd, code, signal, pid, errors }`. The consumer interprets: the same payload means "source ended", "attempt failed", or "crash" depending on the phase.
- **Unexpected process exit** (streamlink or ffmpeg dies) → the pipeline is stopped with reason `process-exit`; the signal in the exit payload makes external kills (OOM, `docker kill`) self-explaining.
- **Zero-listener TTL** — the TTL watcher polls Icecast every 60 s; `STREAM_TTL_MINUTES` (default 15) of zero listeners tears the pipeline down (reason `ttl`).
- A stream that lost its source (mount gone) is reaped by the same TTL watcher (no listeners → TTL). An **unreachable Icecast** counts as zero listeners — admin, source and listeners share port 8080, so nobody can be listening — which also reaps a black-holed pipeline where ffmpeg blocks silently without exiting.
- **Manual stop** (`DELETE /api/stream`) → reason `manual`.

---

## 5. Event bus

A small pub/sub bus carries the outward stream lifecycle notifications. `Stream` is the only emitter; `index.js` (logging) the only consumer. Internal concerns (process exits, TTL expiry) are observed directly via the per-pipeline `onExit`/`onExpired` callbacks, never through the bus. `onExit` fires only for exits the owner did not cause (owner kills stay silent).

| Event            | Emitted by | Consumed by | Payload                                                      |
| ---------------- | ---------- | ----------- | ------------------------------------------------------------ |
| `stream:started` | stream     | logging     | `{ url }`                                                    |
| `stream:stopped` | stream     | logging     | `{ url, reason: manual \| replaced \| process-exit \| ttl }` |
| `stream:error`   | stream     | logging     | `{ url, error }`                                             |

Every pipeline teardown declares its reason. Operational logging flows through the shared pino logger: `Stream` reports lifecycle transitions; collaborators report their own low-level facts directly (pipeline attempt starts, Icecast poll failures).

---

## 6. Health monitoring (#18)

A dedicated `health` container is an independent failure domain: it probes the components from the outside over plain HTTP and aggregates the result. It is the only service besides Caddy with a published host port.

- **Probes** (2 s timeout each, run concurrently):
  - `stream` → `GET stream:8080/api/state`
  - `icecast` → `GET icecast:8080/admin/stats` (basic auth, admin password)
  - `caddy` → `GET caddy:8089/hc` (Caddy's own static liveness route, internal-only)
- **Response:** `{ caddy, icecast, stream }`, each `{ result: 'ok' | 'error', duration, error? }`. HTTP `503` when any component is `error`, otherwise `200` — the status code is the machine-readable verdict.
- A failing **or hanging** component never takes the monitor down: every probe wraps in try/catch with its own timeout.
- **Rate limited** — 60 requests/minute per client (`429` beyond); the limiter is registered before the routes so both `/hc` and `/health` are covered.
- **Unauthenticated by decision** — external probers cannot send auth headers. The endpoint exposes component status only, no control surface.
- Host-resource checks (disk/memory) were considered and **descoped**: the monitor observes service components, not the machine.

---

## 7. Security design

### 7.1 API authentication & key exemption

See §3.1. **Decision — `/api/state` is key-exempt:** the health monitor and plain status probers cannot attach auth headers. The endpoint is read-only status (no control) and is also reachable publicly through Caddy's `/api/*` routing. Accepted exposure: stream state, listener count, component statuses. Revisit if the payload grows more sensitive.

### 7.2 SSRF guard

Strict YouTube URL validation (`isValidYoutubeUrl`): only `youtube.com` / `youtu.be` hosts, HTTP(S) schemes only; rejects IPs, `@` userinfo tricks, and non-standard ports.

### 7.3 Listener limit

`ICECAST_MAX_LISTENERS` (default 2) is enforced by Icecast alone (`<max-listeners>` per mount — excess clients rejected at connect time). The cap is injected into the Icecast config by its container's start command and never reaches the application.

### 7.4 Secrets hygiene

The API key is never logged (constant-time compare + pino redaction, see §3.1). Default credentials (`dev-api-key`, `secret`/`admin`) log startup warnings. Icecast passwords are patched into a tmpfs config copy at container start — the bind-mounted `icecast.xml` stays credential-free.

### 7.5 Container hardening

Every application container: non-root user, read-only root filesystem (tmpfs `/tmp` for scratch), `cap_drop: ALL`, `no-new-privileges: true`, resource limits (CPU/memory), log rotation (json-file, 10 MB × 3). Icecast runs as the image's own `icecast2` user (101:102): the root+sudo `/start.sh` entrypoint is bypassed (sudo needs `CAP_SETUID`), and the compose command patches credentials and `max-listeners` into a tmpfs copy of the config (`/etc/icecast2` stays intact — `/usr/share/icecast2` web/admin files symlink into it).

### 7.6 CI scanning

`npm audit` (gates on `critical`), gitleaks, GitHub **CodeQL** (default setup) for static analysis, **Dependabot** security updates for app-dependency CVEs, Dependabot version updates for npm and GitHub Actions.

> **Decision — container-image Trivy scanning was dropped:** its advisory DB re-rates CVEs over time (revisions can flip findings between CRITICAL and HIGH), making a severity gate non-deterministic. CodeQL + Dependabot give reproducible code & app-dependency coverage instead. Docker ecosystem updates are deferred until E2E tests exist to validate a base-image bump.

Branch protection on `main` requires PR + passing CI.

---

## 8. Dependency pinning policy

All dependencies — npm packages, Docker base images, Docker service images, and system packages — are pinned to exact versions for reproducible builds. Without pinning, a rebuild months later can pull a newer dependency that introduces a breaking change, security regression, or behavior shift. Digests protect against tag mutation; exact versions protect against semver surprises.

| Layer                    | What                             | How                                                                                                     | Update cadence               |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **npm**                  | `fastify`                        | Exact version in `package.json` (no `^`/`~`); `package-lock.json` records resolved URL + integrity hash | Dependabot (npm ecosystem)   |
| **Docker base image**    | `node:24-alpine`                 | Pinned by digest in `Dockerfile.node`                                                                   | When bumping Node or Alpine  |
| **Docker service image** | `moul/icecast`, `caddy:2-alpine` | Pinned by digest in `docker-compose.yml`                                                                | When bumping Icecast / Caddy |
| **apk packages**         | `ffmpeg`, `streamlink`           | Exact version via compose build args                                                                    | When bumping any package     |

Resolving digests and versions:

```bash
docker pull node:24-alpine
docker inspect node:24-alpine --format='{{index .RepoDigests 0}}'
docker run --rm node:24-alpine apk info -a ffmpeg streamlink
```

---

## 9. Logging

Every service logs to stdout/stderr → `docker logs`. The Node services use pino (JSON, level via `LOG_LEVEL`); Caddy and Icecast log to their own stderr (access log off). The json-file driver with rotation (10 MB × 3) is set on all compose services; `docker compose logs --timestamps` shows unified UTC stamps.

---

## 10. Testing, linting & CI

- **Unit tests** — `node:test` with built-in `mock.fn()`/`mock.module` (`--experimental-test-module-mocks`), real processes where sensible (the `ChildProcess` one-shot wrapper is tested against real `node` processes). Coverage: process lifecycle and kill fallbacks, wrapper spawn args, `ProxyList` (optional-file loading with degradation, request-scoped rotation), Icecast admin client, pipeline orchestration (attempts + fresh pairs, readiness polling, fail-fast attribution, TTL), Stream orchestration (replace/stop/failure accounting, event emission, health snapshot), auth (header/query/missing/invalid), route status codes, health probes and aggregation, shared `Config` defaults/overrides/immutability, SSRF cases, oEmbed metadata.
- **Linting & formatting** — `oxlint` + `oxfmt`, configured once at the repo root; every workspace exposes `lint` / `format` / `format:check` scripts.
- **CI** — lint + format-check + tests on every PR open/update; dependency & secret scanning (§7.6); merge blocked on failure via branch protection.

---

## 11. Recorded decisions log

| #  | Decision                                                             | Rationale                                                                                                              |
| -- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1  | streamlink replaces yt-dlp for stream extraction (2026-08)           | streamlink's HLS client keeps up with YouTube's 30 s live window; bare ffmpeg/yt-dlp could not                         |
| 2  | No explicit state machine — sequential `async/await`, derived phase  | The PoC state machine duplicated information the processes already expose; derived phase cannot drift from reality     |
| 3  | Event bus carries only outward `stream:*` notifications              | Internal concerns observed directly per pipeline; the bus stays a thin logging seam, not an orchestration mechanism    |
| 4  | API moved under `/api/` prefix                                       | Avoids the collision between the `/stream` management route and the `/stream` audio mount                              |
| 5  | Caddy is the only public door; `handle` blocks everywhere            | Mixed path-matched directives reorder under Caddy's directive ordering — see the warning in §2                         |
| 6  | Dedicated `health` container, published on its own port (#18)        | Independent failure domain; external probers cannot send auth headers; a wedged component cannot take the monitor down |
| 7  | `/api/state` is key-exempt (#18)                                     | Read-only status needed by header-less probers; accepted exposure — see §7.1                                           |
| 8  | Internal ports fixed at 8080 (all services) + Caddy liveness on 8089 | Per-container namespaces make them collision-free; only host-published ports need configuring                          |
| 9  | Trivy image scanning dropped from CI                                 | Advisory DB re-rates CVEs over time → non-deterministic severity gate (§7.6)                                           |
| 10 | npm-workspaces monorepo, `yt-stream-shared` Config                   | Two services, one env contract — no drift between copies                                                               |
| 11 | Proxies: random pick per start, from a JSON list                     | Residential IPs are required to pass YouTube's bot checks; rotation spreads rate-limit exposure                        |
| 12 | `PROXY_FILE` is host-side only; in-container path fixed (#35)         | Compose mounts `${PROXY_FILE:-./proxy.json}` with `create_host_path: false` — the mount is the knob; a missing file fails `up` loudly instead of silently creating a directory; the app reads exactly `/app/proxy.json`, no cwd-relative fallback |
| 13 | Start attempts rotate proxies; failures log the proxy (#35)          | Attempts draw from a per-request shuffled rotation — a poisoned exit is never retried through itself; per-attempt redacted-proxy logs make bad exits diagnosable in one line |
| 14 | `ProxyList` owns file→pool; rotation is a per-request iterator      | Only the stream consumes proxies, and only it has a logger at load time — load problems warn and degrade to a direct connection; rotation state lives in the iterator, so interleaved starts cannot corrupt each other |
| 15 | `socks5`/`socks5h` proxy schemes accepted (#35 follow-up)             | streamlink delegates to requests; PySocks ships with the Alpine streamlink package (verified in-image); `socks5h` resolves DNS at the exit — preferred for residential providers |
| 16 | Process wrappers are one-shot: one instance = one process            | The host model emulated process identity inside a longer-lived object (kill-mark graveyard, null-proc tri-state, replace-on-spawn). One-shot instances make identity real; retries construct fresh pairs; `spawn`/`onExit` chain, `kill` stays a promise |
| 17 | `StreamPipeline` lives in its own module                             | Each layer gets its own test seam: the pipeline is tested against mocked wrappers/Icecast, `Stream` against a fake pipeline — instead of both through one facade |
