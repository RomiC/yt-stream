# Implementation Plan

> **Status: superseded.** Historical PoC plan — the current architecture is defined in [`docs/PRD-6-7.md`](docs/PRD-6-7.md).

> **Note:** The final implementation was simplified from this plan: retries, persistence, and startup resume were removed. See DESIGN.md for the PoC architecture. **2026-08 update:** the streaming pipeline no longer uses `yt-dlp`. The live stream is now fetched by **streamlink** (optionally through a rotating proxy from `proxy.json`) and piped into ffmpeg, which only transcodes to MP3 and pushes to Icecast. Sections below referencing yt-dlp/cookies are historical.

## Architecture Overview (historical)

```
src/
├── index.js              # Entry point: Fastify app, route registration, startup
├── config.js             # Environment variable loading, config object
├── logger.js             # Fastify logger instance (pino, JSON to stdout)
├── routes.js             # All HTTP route handlers (/stream, /health)
├── stream-manager.js     # State machine, ffmpeg lifecycle, retries, TTL, persistence
├── icecast-client.js     # Icecast admin API polling (listener count, mountpoint status)
└── health.js             # Component status aggregation for /health endpoint
```

**Data flow:**

```
HTTP request → routes.js → stream-manager.js → spawn ffmpeg → Icecast
                               │                      │
                               ▼                      ▼
                        stream-state.json    icecast-client.js (polling)
                               │                      │
                               └──────────┬───────────┘
                                          ▼
                                     health.js
```

**Module responsibilities:**

| Module              | Owns                                                                          | Exposes                                                              |
| ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `config.js`         | Env var parsing, defaults                                                     | Immutable config object                                              |
| `logger.js`         | Pino instance configured for JSON                                             | Logger instance (or re-export from Fastify)                          |
| `icecast-client.js` | HTTP Basic Auth, XML parsing, 15s polling interval                            | `getStatus()` → `{ mountpointActive, listeners }`                    |
| `stream-manager.js` | State machine, ffmpeg spawn/kill, retry backoff, TTL timer, state persistence | `start(url)`, `stop()`, `getState()`, EventEmitter for state changes |
| `health.js`         | Aggregates stream-manager + icecast-client status                             | `getHealth()` → `{ status, components, stream? }`                    |
| `routes.js`         | Fastify route definitions, request validation, response formatting            | Fastify plugin (registers routes)                                    |
| `index.js`          | Fastify instance creation, plugin registration, server start                  | —                                                                    |

---

---

## Dependency Pinning Policy

All dependencies — npm packages, Docker base images, Docker service images, and system packages — must be pinned to exact versions for reproducible builds.

| Layer                    | What                   | How                                                                                                               | Update cadence                     |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **npm**                  | `fastify`              | Exact version in `package.json` (`5.3.2`, no `^`/`~`). `package-lock.json` records resolved URL + integrity hash. | Manual review with `npm outdated`  |
| **Docker base image**    | `node:24-alpine`       | Pinned by digest: `node:24-alpine@sha256:d32cdf...`                                                               | Update when bumping Node or Alpine |
| **Docker service image** | `moul/icecast`         | Pinned by digest: `moul/icecast@sha256:b35cd6...`                                                                 | Update when bumping Icecast        |
| **apk packages**         | `ffmpeg`, `streamlink` | Exact version: `ffmpeg=8.1.2-r0`, `streamlink=8.4.0-r0`                                                           | Update when bumping any package    |

**Commands for resolving digests and versions:**

```bash
# Docker image digest
docker pull node:24-alpine
docker inspect node:24-alpine --format='{{index .RepoDigests 0}}'

docker pull moul/icecast
docker inspect moul/icecast --format='{{index .RepoDigests 0}}'

# Alpine package versions
docker run --rm node:24-alpine apk info -a ffmpeg yt-dlp curl

# npm integrity check
npm ci  # enforces package-lock.json hashes
```

**Rationale:** Without pinning, a rebuild 6 months later can pull a new minor/patch of a dependency that introduces a breaking change, security regression, or behavior shift. Digests protect against tag mutation; exact versions protect against semver surprises.

---

## Step-by-Step Implementation

### Step 1: Project Scaffolding

**Files created:**

- `package.json`
- `Dockerfile`
- `docker-compose.yml`

**package.json** — all dependencies pinned to exact versions (no `^` or `~`):

```json
{
  "name": "yt-stream",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js"
  },
  "dependencies": {
    "fastify": "5.3.2"
  },
  "engines": {
    "node": ">=24.0.0"
  }
}
```

> **Update policy:** Check for newer versions with `npm outdated` before bumping. Record the resolved URL + SHA-512 in `package-lock.json` (committed to repo).

**Dockerfile** — base image pinned by digest, system packages pinned by version:

```dockerfile
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

# System dependencies pinned to exact versions for reproducible builds.
RUN apk add --no-cache \
    ffmpeg=8.1.2-r0 \
    yt-dlp=2026.07.04-r0 \
    yt-dlp-ejs-rt-quickjs=0.8.0-r1 \
    && rm -rf /var/cache/apk/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY src/ ./src/
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["node", "src/index.js"]
```

> **Digest retrieval:** `bash docker pull node:24-alpine && docker inspect node:24-alpine --format='{{index .RepoDigests 0}}' ` **Package version lookup:** `bash docker run --rm node:24-alpine apk info -a ffmpeg yt-dlp curl ` Replace `<digest>` and version strings with the actual values resolved at build time.

**docker-compose.yml** — Icecast image pinned by digest:

```yaml
# icecast service — use digest for reproducible deployments
image: moul/icecast@sha256:b35cd6367327335b51b989c277e6feaff7cd61d65846ec7fee361c6eb1cea620
```

> Retrieve with: `bash docker pull moul/icecast && docker inspect moul/icecast --format='{{index .RepoDigests 0}}' ` The rest of docker-compose.yml is copied verbatim from DESIGN.md.

**Acceptance:** `docker compose up` starts both containers. Fastify boots and logs to stdout.

---

### Step 2: Config Module

**File:** `src/config.js`

```js
export default {
  port: parseInt(process.env.PORT || "8080", 10),
  icecast: {
    host: process.env.ICECAST_HOST || "icecast",
    port: parseInt(process.env.ICECAST_PORT || "8000", 10),
    sourcePassword: process.env.ICECAST_SOURCE_PASSWORD || "secret",
    adminPassword: process.env.ICECAST_ADMIN_PASSWORD || "admin",
  },
  publicHostname: process.env.PUBLIC_HOSTNAME || "localhost",
  dataDir: process.env.DATA_DIR || "./data",
  logLevel: process.env.LOG_LEVEL || "info",
  streamTtlMinutes: parseInt(process.env.STREAM_TTL_MINUTES || "15", 10),
  ytdlpProxy: process.env.YTDLP_PROXY || null,
  cookiesPath: process.env.COOKIES_PATH || null,
};
```

**Constraints:**

- Exported as a frozen / read-only object.
- All defaults match DESIGN.md.
- No validation beyond `parseInt` — invalid values fail fast at first use.

**Acceptance:** Fastify starts with configured port. Changing `PORT` env var changes listen port.

---

### Step 3: Logger & Fastify App Skeleton

**File:** `src/index.js`

```js
import Fastify from "fastify";
import config from "./config.js";
import { registerRoutes } from "./routes.js";

const app = Fastify({
  logger: {
    level: config.logLevel,
    // pino defaults to JSON; no pretty-print
  },
});

await registerRoutes(app);

await app.listen({ port: config.port, host: "0.0.0.0" });
```

**Key points:**

- Fastify's default logger is pino. No separate `pino` import needed.
- Log level from `LOG_LEVEL` env var.
- Server binds to `0.0.0.0` inside Docker.

**File:** `src/routes.js` (skeleton)

```js
export async function registerRoutes(app) {
  // Placeholder — no routes yet
  app.get("/health", async () => ({ status: "ok" }));
}
```

**Acceptance:** `docker compose up`, `curl http://localhost:8080/health` → `{"status":"ok"}`. Logs are JSON.

---

### Step 4: Icecast Client

**File:** `src/icecast-client.js`

```js
import config from "./config.js";

const ICE_URL = `http://${config.icecast.host}:${config.icecast.port}/admin/listmounts`;
const AUTH = Buffer.from(`admin:${config.icecast.adminPassword}`).toString("base64");
const POLL_INTERVAL = 15_000;

let status = { mountpointActive: false, listeners: 0 };

function parseXml(text) {
  // Parse Icecast admin XML. Look for:
  // <source mount="/stream"> ... <listeners>N</listeners> ... </source>
  // Return { mountpointActive: true/false, listeners: number }
}

async function poll() {
  try {
    const res = await fetch(ICE_URL, {
      headers: { Authorization: `Basic ${AUTH}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    status = parseXml(await res.text());
  } catch (err) {
    status = { mountpointActive: false, listeners: 0 };
    // Log via app.log or a passed logger reference
  }
}

// Start polling, return current status getter
export function startPolling(logger) {
  poll(); // immediate first poll
  const interval = setInterval(poll, POLL_INTERVAL);
  return {
    getStatus: () => ({ ...status }),
    stop: () => clearInterval(interval),
  };
}
```

**Key decisions:**

- XML parsing: use a lightweight approach. Icecast `/admin/listmounts` XML is simple enough for a regex or `DOMParser` (available in Node 24 via `jsdom`? No — Node doesn't have native DOMParser). Options:
- **Recommendation:** Use `fast-xml-parser` (small, zero-dep) or write a minimal regex-based parser since the XML structure is predictable.
- The polling function takes a `logger` reference so it can log errors/warnings.
- `getStatus()` returns a shallow copy to prevent mutation.

**Acceptance:** Mock Icecast XML response or test against real Icecast. `getStatus().listeners` reflects current listener count.

---

### Step 5: Stream Manager — Core State Machine & Pipeline

**File:** `src/stream-manager.js`

This is the largest module. Implement in sub-steps:

#### 5a. State Machine

```js
const VALID_TRANSITIONS = {
  idle: ["starting"],
  starting: ["streaming", "retrying"],
  streaming: ["retrying", "stopped", "starting"],
  retrying: ["streaming", "stopped"],
  stopped: ["starting"],
};

let state = "idle";
let currentUrl = null;

function transition(newState) {
  if (!VALID_TRANSITIONS[state].includes(newState)) {
    throw new Error(`Invalid transition: ${state} → ${newState}`);
  }
  state = newState;
  // emit event for health/routes to consume
}
```

**States & transitions table:** copied from REQUIREMENTS.md.

#### 5b. Pipeline Spawn

```js
import { spawn } from "child_process";
import config from "./config.js";

function buildFfmpegArgs(audioUrl) {
  const icecastUrl = `icecast://source:${config.icecast.sourcePassword}@${config.icecast.host}:${config.icecast.port}/stream`;
  return [
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-i",
    audioUrl,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "128k",
    "-content_type",
    "audio/mpeg",
    "-f",
    "mp3",
    icecastUrl,
  ];
}

async function extractAudioUrl(youtubeUrl) {
  // spawn yt-dlp, capture stdout
  const args = ["-f", "bestaudio", "--get-url"];
  if (config.ytdlpProxy) args.push("--proxy", config.ytdlpProxy);
  if (config.cookiesPath) args.push("--cookies", config.cookiesPath);
  args.push(youtubeUrl);

  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`yt-dlp exit ${code}`));
    });
    proc.on("error", reject);
  });
}
```

#### 5c. Retry Logic

```js
const BACKOFF = [1000, 2000, 4000, 8000, 16000, 60000]; // ms
const MAX_RETRIES = 10;

let retryCount = 0;

function retryDelay(attempt) {
  return BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
}
```

#### 5d. Start / Stop

```js
let ffmpegProc = null;

async function start(youtubeUrl) {
  // If already running with same URL → noop (idempotent)
  // If running with different URL → stop(), then start()
  // Extract audio URL → spawn ffmpeg → transition to streaming
  // On ffmpeg exit → check code, decide retry or stop
}

async function stop() {
  // SIGTERM → wait 5s → SIGKILL
  // Transition to stopped
  // Persist state
}
```

**Acceptance:** Manual test — `start()` spawns ffmpeg visible in `ps aux`. `stop()` kills it. State transitions log correctly.

---

### Step 6: API Routes

**File:** `src/routes.js`

Four routes as specified:

| Route                 | Handler behavior                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /stream?url=...` | Call `streamManager.start(url)`. If state becomes `streaming`, reply `302`. If `starting`, reply `202`. If error, reply `500`. |
| `GET /stream`         | Return current `streamManager.getState()` as JSON.                                                                             |
| `DELETE /stream`      | Call `streamManager.stop()`. Return `200` or `404`.                                                                            |
| `GET /health`         | Call `health.getHealth()`. Return `200` or `503`.                                                                              |

**Fastify details:**

- Use Fastify schema validation for query params (`url` must be present, non-empty string).
- `302` redirects via `reply.redirect(streamUrl)`.
- `GET /stream` (without `url`) and `GET /stream?url=...` are the same path — route handler checks `request.query.url` presence to distinguish.

```js
app.get("/stream", async (request, reply) => {
  const { url } = request.query;
  if (url) {
    // start or idempotent redirect
  } else {
    // return current status
  }
});
```

**Acceptance:** Full API smoke test against running containers.

---

### Step 7: Persistence & Startup Resume

**File:** handled inside `stream-manager.js`

```js
import { writeFile, rename, readFile } from "fs/promises";
import { join } from "path";

const STATE_FILE = join(config.dataDir, "stream-state.json");

async function saveState() {
  const tmp = STATE_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify({ youtube_url: currentUrl, state }));
  await rename(tmp, STATE_FILE); // atomic on same filesystem
}

async function loadState() {
  try {
    const data = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null; // file missing or corrupted → start idle
  }
}

// Called at startup:
const saved = await loadState();
if (saved && (saved.state === "streaming" || saved.state === "starting")) {
  currentUrl = saved.youtube_url;
  start(currentUrl); // fire-and-forget resume
}
```

**Acceptance:** Start a stream, `docker compose restart stream-service`, verify stream auto-resumes.

---

### Step 8: TTL Auto-Stop

**File:** handled inside `stream-manager.js`

```js
let idleSince = null; // timestamp when listeners hit 0

function onPollResult({ listeners }) {
  if (state !== "streaming") return;

  if (listeners === 0) {
    if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince >= config.streamTtlMinutes * 60_000) {
      stop(); // TTL expired
    }
  } else {
    idleSince = null; // reset
  }
}
```

Integration: `stream-manager.js` receives poll results via a callback or the icecast client's `getStatus()` called on the same 15s interval.

**TTL=0 behavior:** If `STREAM_TTL_MINUTES=0`, auto-stop is disabled (never stops based on idle).

**Acceptance:** Start stream, disconnect all listeners, wait 15 min, verify ffmpeg is killed and state is `stopped`.

---

### Step 9: Health Module

**File:** `src/health.js`

```js
export function createHealth(streamManager, icecastClient) {
  return function getHealth() {
    const icecast = icecastClient.getStatus();
    const stream = streamManager.getState();

    const components = {
      icecast: {
        status: icecast.mountpointActive ? 'reachable' : 'unreachable',
        ...(icecast.mountpointActive ? { mountpoint_active: true } : {}),
      },
    };

    if (stream.state !== 'idle') {
      components.ffmpeg = {
        status: stream.state === 'streaming' ? 'running' : stream.state,
        ...(stream.pid ? { pid: stream.pid } : {}),
      };
    }

    const ok = icecast.mountpointActive !== false;
    return {
      status: ok ? 'ok' : 'degraded',
      components,
      ...(stream.state !== 'idle' ? { stream: { ... } } : {}),
    };
  };
}
```

**Acceptance:** `GET /health` returns structure matching REQUIREMENTS.md for all states (idle, streaming, icecast down).

---

### Step 10: Integration & Smoke Test

**Manual test checklist:**

1. `docker compose up` — both containers healthy.
2. `curl http://localhost:8080/health` → `{"status":"ok","components":{"icecast":{"status":"reachable"}}}`.
3. `curl -v "http://localhost:8080/stream?url=https://www.youtube.com/watch?v=jfKfPfyJRdk"` → `302` with `Location: http://localhost:8000/stream`.
4. Open `http://localhost:8000/stream` in VLC or browser — audio plays.
5. `curl http://localhost:8080/stream` → `{"state":"streaming","listeners":1,...}`.
6. `curl "http://localhost:8080/stream?url=<same>"` → `302` (idempotent, no restart).
7. `curl "http://localhost:8080/stream?url=<different>"` → `302` (old killed, new started).
8. `curl -X DELETE http://localhost:8080/stream` → `{"state":"stopped",...}`.
9. `curl http://localhost:8080/stream` → `{"state":"idle"}`.
10. `docker compose restart stream-service` → after restart, `GET /stream` shows `streaming` with the old URL.
11. Disconnect all listeners, wait 15 min → stream auto-stops.
12. `docker compose down` → all containers stop cleanly.

---

## Implementation Order (Summary)

| Step | Module                                                           | Depends on | Estimated effort |
| ---- | ---------------------------------------------------------------- | ---------- | ---------------- |
| 1    | Scaffolding (`package.json`, `Dockerfile`, `docker-compose.yml`) | —          | Small            |
| 2    | `config.js`                                                      | Step 1     | Small            |
| 3    | `index.js` + `routes.js` skeleton                                | Steps 1, 2 | Small            |
| 4    | `icecast-client.js`                                              | Steps 2, 3 | Medium           |
| 5    | `stream-manager.js`                                              | Steps 2, 4 | Large            |
| 6    | `routes.js` (full)                                               | Steps 3, 5 | Medium           |
| 7    | Persistence (in stream-manager)                                  | Step 5     | Small            |
| 8    | TTL auto-stop (in stream-manager)                                | Steps 4, 5 | Small            |
| 9    | `health.js`                                                      | Steps 4, 5 | Small            |
| 10   | Integration & smoke test                                         | All        | Medium           |

Steps 1–3 produce a running (but useless) service. Steps 4–6 produce a working single-stream service. Steps 7–9 add resilience and monitoring. Step 10 validates everything end-to-end.

---

## Open Design Decisions

| #   | Decision                                          | Recommendation                                                                        | Rationale                                                                         |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | XML parsing for Icecast admin API                 | `fast-xml-parser` or regex                                                            | Icecast XML is simple and stable. Regex avoids a dependency for 2 fields.         |
| 2   | Separate `logger.js` vs Fastify's `app.log`       | Pass `app.log` to modules                                                             | Fewer files, no circular dependency risk. Export a factory that takes the logger. |
| 3   | Stream manager as a class vs module with closures | Module with factory function `createStreamManager({ logger, icecastClient, config })` | Easier testing via dependency injection, no `this` binding issues.                |
| 4   | EventEmitter for state changes vs callbacks       | `EventEmitter` (Node built-in)                                                        | Routes and health can subscribe to state changes without tight coupling.          |
