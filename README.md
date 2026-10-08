# yt-stream

> Written by 🤖 AI, driven and reviewed by a 👨‍💻 human.

A self-hosted service that turns a YouTube live stream or video into an Icecast-compatible MP3 audio stream. One `GET` request with a YouTube URL starts the stream and redirects you to a mountpoint playable by any radio receiver, VLC, or browser.

The service manages exactly **one stream at a time** — starting a new YouTube URL replaces the current one.

Architecture, design decisions, and security rationale are documented in **[DESIGN.md](DESIGN.md)**.

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quickstart](#quickstart)
- [How to deploy](#how-to-deploy)
  - [Production security checklist](#production-security-checklist)
- [Proxies](#proxies)
- [TLS](#tls)
  - [Using your own certificate](#using-your-own-certificate)
  - [Renewing certificates](#renewing-certificates)
  - [Caveats](#caveats)
- [API](#api)
- [Configuration](#configuration)
- [Status and logs](#status-and-logs)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## How it works

Four Docker containers behind a single public entry point:

- **Caddy** — reverse proxy and the only public door (ports 80/443). Routes `/api/*` to the stream service and `/stream` to Icecast; everything else returns 404. Handles TLS — automatic HTTPS or operator-provided certificates ([details](#tls)).
- **stream** (Bun) — the application. Validates the URL, runs the `streamlink → ffmpeg` pipeline, pushes MP3 audio to Icecast, watches listener counts.
- **Icecast** — the streaming server. Serves the audio on the `/stream` mountpoint to any number of listeners (capped by `ICECAST_MAX_LISTENERS`).
- **health** (Bun) — an independent monitor on its own port (`HEALTH_PORT`) that probes Caddy, Icecast, and the stream service and reports a single verdict.

A separate `shared` package holds the configuration common to both services.

## Requirements

- Docker with Compose v2
- A **residential IP address** — see [Proxies](#proxies) below; without one YouTube will most likely block stream extraction

## Quickstart

Request examples use `yts.example.com`: replace it with your hostname and point its DNS at the server. For local development, set `PUBLIC_BASE_URL=http://yts.localhost` and replace `https://yts.example.com` with `http://yts.localhost`; use `http://yts.localhost:8080/hc` for health checks. A service-specific `.localhost` subdomain helps distinguish yt-stream from other local services. If your client does not resolve it automatically, add `127.0.0.1 yts.localhost` to your hosts file.

For a non-standard local HTTP port, keep `PUBLIC_BASE_URL` portless and include the host port only in request URLs:

```env
PUBLIC_BASE_URL=http://yts.localhost
HTTP_PORT=8081
```

Open `http://yts.localhost:8081/stream` and use `http://yts.localhost:8081/api/stream` for API requests. Compose forwards host port 8081 to Caddy's container port 80; putting `:8081` in `PUBLIC_BASE_URL` would instead make Caddy listen on container port 8081 and break that mapping. The separate health port is unchanged.

1. Create (or copy from example) `.env`

```bash
cp .env.example .env
```

2. Create the proxy list (mounted into the stream container; must exist before start — see [Proxies](#proxies)). The template ships example entries — **edit it before starting**: paste your own proxies, or empty it (`[]`) to connect directly

```bash
cp proxy.json.example proxy.json
```

3. Set your public URL and `API_KEY` to protect `/api/*` endpoints. Automatic HTTPS requires ports 80/443 to be reachable; see [TLS](#tls) for other modes.

```
# editing .env
PUBLIC_BASE_URL=https://yts.example.com
API_KEY=<random-api-key-string>
```

4. Start the service

```bash
docker compose up -d --build
```

5. Wait for the stack to come up, then check health:

```bash
curl http://yts.example.com:8080/hc
# {"caddy":{"result":"ok",...},"icecast":{"result":"ok",...},"stream":{"result":"ok",...}}
```

6. Start a stream (substitute `<your-api-key>` with API key set in `.env`)

```bash
curl -H "Authorization: Bearer <your-api-key>" \
  "https://yts.example.com/api/stream?url=https://www.youtube.com/watch?v=<id>"
# 302 Found — Location: /stream
```

7. Open `https://yts.example.com/stream` in VLC, a browser, or any radio client.
8. [Optional] Stop it manually (substitute `<your-api-key>` with API key set in `.env`):

```bash
curl -X DELETE -H "Authorization: Bearer <your-api-key>" https://yts.example.com/api/stream
```

The stream also stops on its own:

- **TTL** — after `STREAM_TTL_MINUTES` (default 15) with **zero listeners**; a stream nobody listens to winds down by itself
- **Pipeline failure** — if streamlink or ffmpeg dies (bad URL, YouTube block, proxy down)
- **Replacement** — starting a new URL replaces the current stream

## How to deploy

Production deploys use prebuilt GHCR images from a GitHub Release tag. This flow requires Docker Compose v2.24.4 or newer because `docker-compose.release.yml` uses merge reset tags. Do not deploy `latest`; pin the exact release in a local `.env.release` file next to the production `.env`:

```env
VERSION=v1.0.0
```

Review the fully merged production config before changing containers:

```bash
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  config
```

Start the selected release:

```bash
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  up -d --no-build --pull missing --remove-orphans
```

To roll back, change `VERSION` to the previous release, then rerun the same command. A release change recreates the stream container: the active stream is not restored automatically; start it again through the API.

### Production security checklist

- Set unique, random `API_KEY`, `ICECAST_SOURCE_PASSWORD`, and `ICECAST_ADMIN_PASSWORD` values; never deploy the defaults. `openssl rand -hex 32` generates a value suitable for each secret.
- Set `PUBLIC_BASE_URL` to your public HTTPS URL and configure [TLS](#tls).
- Enable `ALLOW_KEY_IN_QUERY=true` if you need a single start-and-play link to paste into a player that cannot send an authorization header. If you do not use this workflow, keep it `false` (or turn it off) and use bearer headers instead. Treat player-ready links as secrets: they contain your API key and can appear in player history, browser history, or proxy logs.
- Restrict `HEALTH_PORT` to trusted monitoring clients using host/cloud firewall rules. Compose publishes it on all host interfaces by default; `/hc` has no authentication or TLS.
- Keep stream and Icecast ports internal; do not publish their admin/control endpoints.
- Keep `.env` and credential-bearing `proxy.json` out of version control. Restrict `.env` access (for example, `chmod 600 .env`); restrict the proxy file too, but keep it readable by the container user (UID/GID 1000 on Linux bind mounts). An unreadable proxy file makes the app fall back to direct access.
- Pin the release in `.env.release` and review the merged Compose config locally; its output contains secrets, so do not share it unredacted.

## Proxies

YouTube aggressively blocks requests from datacenter/VPS IP ranges. If the service runs on a VPS (the typical case), stream extraction will almost certainly fail without a proxy:

- The host itself needs a **residential IP**, or the traffic must be routed through **residential proxies** — only residential IPs reliably pass YouTube's bot checks.
- Provide a list of proxy URLs in a `proxy.json` file at the repo root (JSON array of `http(s)`/`socks5`/`socks5h` URLs, credentials included inline), e.g. gateways with rotating and sticky-session endpoints:

  ```json
  [
    "http://user:pass@gate.example.com:7000",
    "https://user-session-a1b2c3:pass@gate.example.com:10001",
    "socks5h://user:pass@gate.example.com:1080"
  ]
  ```

  `socks5h://` resolves DNS at the proxy exit — prefer it over `socks5://` (local DNS) for residential providers.

  `PROXY_FILE` in `.env` points at this file **on the host** (default `./proxy.json`); compose mounts it read-only into the stream container at the fixed path `/app/proxy.json` — the only path the app reads. Local dev outside Docker therefore always connects directly. The file must exist before `docker compose up` — compose fails fast when it is missing (start from the template: `cp proxy.json.example proxy.json`). At runtime the file is optional and never blocks startup: missing, malformed, or without valid entries → a single startup warning, and streamlink connects directly.

- Each start uses a freshly **shuffled** proxy list; retry attempts (up to 3) advance without repeating an entry until the pool is exhausted, then reshuffle. With fewer proxies than attempts, a proxy can be reused once the pool is exhausted. The chosen proxy is logged (redacted) per attempt. Duplicate entries collapse at load; an empty list (`[]`) connects directly.
- The list is loaded at application startup, not per request. After editing it, recreate the stream container to reload the file; this interrupts the current stream, which must be started again.

## TLS

Caddy picks one of three modes at container start, from `PUBLIC_BASE_URL` and whether a certificate pair is provided:

| Mode                | When                                          | Behavior                                                                                                |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Automatic HTTPS** | `PUBLIC_BASE_URL=https://…`, no pair provided | Caddy obtains and renews Let's Encrypt certs; needs `:80`/`:443` reachable (HTTP-01 / TLS-ALPN-01)      |
| **Provided certs**  | `TLS_CERT_FILE` **and** `TLS_KEY_FILE` set    | Caddy serves that pair and skips ACME; works on **any** host ports — the mode for blocked/shared 80/443 |
| **Plain HTTP**      | `PUBLIC_BASE_URL=http://…`                    | No TLS (local development)                                                                              |

### Using your own certificate

Set both variables to **host paths** and start:

```bash
# .env
PUBLIC_BASE_URL=https://yts.example.com
TLS_CERT_FILE=/etc/letsencrypt/live/yts.example.com/fullchain.pem   # symlinks OK
TLS_KEY_FILE=/etc/letsencrypt/live/yts.example.com/privkey.pem

docker compose up -d
```

The command above is for a local/source-built stack. In production, apply these `.env` changes using the full [release deployment command](#how-to-deploy); preserve its environment files and Compose override for log commands too.

- The pair is mounted as **files**, so Docker resolves each path — symlinks included — on the **host** when the container is created. Mounting certbot's `live/<domain>/` as a directory would not work: its links point at `../../archive/…`, which doesn't exist inside the container.
- `TLS_CERT_FILE` must be the full chain (leaf **and** intermediates); a bare leaf makes clients fail with `unable to get local issuer certificate`. Certbot's `fullchain.pem` already includes them.
- Verify ACME is off: `docker compose logs caddy | grep "skipping automatic certificate management"`.
- A wrong path fails `up` loudly (the mounts refuse to create host paths); leaving both variables unset keeps automatic HTTPS — an empty committed placeholder is mounted instead.

### Renewing certificates

Certbot renews on its own — the package ships a systemd timer (`systemctl list-timers certbot.timer`; cron-based distros use `/etc/cron.d/certbot`). A renewed pair is **not** picked up automatically, for two independent reasons:

1. Docker resolved the `live/` symlinks at container creation and pinned the result for the container's lifetime — repointing them changes nothing for the running container.
2. Caddy never re-reads file-loaded certificates in a running process ([caddy#5139](https://github.com/caddyserver/caddy/issues/5139)).

So each renewal must **recreate the caddy container**. Wire it into certbot with a deploy hook — after every successful renewal (timer-driven included) certbot executes the scripts in `/etc/letsencrypt/renewal-hooks/deploy/` with `RENEWED_DOMAINS` set:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/yt-stream.sh
#!/bin/sh
case " $RENEWED_DOMAINS " in
  *" yts.example.com "*) ;; # exact token — `notyts.example.com` must not match
  *) exit 0 ;;
esac
cd /srv/yt-stream || exit 1 # where this repository lives
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  up -d --no-deps --no-build --force-recreate caddy
```

This hook uses the [production release configuration](#how-to-deploy); `--no-deps` recreates only Caddy. For a local/source-built stack without `.env.release`, use `docker compose up -d --no-deps --force-recreate caddy` instead.

```bash
chmod +x /etc/letsencrypt/renewal-hooks/deploy/yt-stream.sh
RENEWED_DOMAINS=yts.example.com /etc/letsencrypt/renewal-hooks/deploy/yt-stream.sh   # smoke-test
# full end-to-end rotation test (counts against Let's Encrypt rate limits):
certbot renew --force-renewal --cert-name yts.example.com
```

Recreating caddy briefly severs live `/stream` connections; clients reconnect. (The zero-downtime alternative — copying the pair into the container and issuing `caddy reload --force` — was rejected as more moving parts; see [DESIGN.md](DESIGN.md), decision 18.)

### Caveats

- Caddy's automatic HTTP→HTTPS redirect assumes the standard HTTPS port: with a custom `HTTPS_PORT`, `http://host:HTTP_PORT` redirects to `https://host` (port 443). Leave `HTTP_PORT` unpublished, or use the HTTPS URL directly.
- On SELinux-enforcing hosts (Fedora/RHEL) the file binds may need a `z` label (`bind: { selinux: "z" }`).

## API

All `/api/*` endpoints require an API key: `Authorization: Bearer <key>` header, or `?key=<key>` query param when `ALLOW_KEY_IN_QUERY=true`.

Query-key authentication exists to provide a **single link you can paste directly into a player**: it starts the requested YouTube stream and redirects the player to `/stream`, without requiring a custom authorization header. Enable `ALLOW_KEY_IN_QUERY=true` and use a player that follows HTTP redirects:

```text
https://yts.example.com/api/stream?key=<your-api-key>&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D<video-id>
```

Replace the host and placeholders; URL-encode the API key and the complete YouTube URL as query parameter values. The link contains a credential, so do not share it publicly. If you only use header-authenticated API requests and open `/stream` separately, keep `ALLOW_KEY_IN_QUERY=false` or turn it off when no longer needed.

| Method   | Path                                     | Auth | Purpose                                                            |
| -------- | ---------------------------------------- | ---- | ------------------------------------------------------------------ |
| `GET`    | `/api/stream?url=<youtube_url>`          | ✅   | Start a stream; `302` redirect to the audio mount                  |
| `DELETE` | `/api/stream`                            | ✅   | Stop the current stream                                            |
| `GET`    | `/api/state`                             | ✅   | Service status + health verdict (JSON)                             |
| `GET`    | `/stream`                                | —    | Audio mount (Icecast, via Caddy) — play it in any client           |
| `GET`    | `/hc` (alias `/health`) on `HEALTH_PORT` | —    | Component health of caddy / icecast / stream; `503` if any is down |

Status codes for `GET /api/stream`: `302` success (redirect), `400` missing/invalid URL, `401` missing/invalid key, `429` another stream operation is in progress, `500` extraction/transcode/Icecast failure. `DELETE /api/stream` returns `200` (stopped), `404` (no active stream), or `429`.

## Configuration

Everything is configured via environment variables (see `.env.example`):

| Variable                  | Default            | Description                                                                                              |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`         | `http://localhost` | Public base URL — Caddy site address (`https://…` enables auto-HTTPS) and stream URLs                    |
| `HTTP_PORT`               | `80`               | Host port → Caddy HTTP                                                                                   |
| `HTTPS_PORT`              | `443`              | Host port → Caddy HTTPS                                                                                  |
| `TLS_CERT_FILE`           | —                  | Host path to the full chain (leaf + intermediates); symlink resolved by Docker                           |
| `TLS_KEY_FILE`            | —                  | Host path to the private key; both set → Caddy serves the pair, ACME skipped                             |
| `HEALTH_PORT`             | `8080`             | Host port → health service                                                                               |
| `API_KEY`                 | `dev-api-key`      | API key for `/api/*`, also used by the health probe (dev fallback logs a startup warning)                |
| `ALLOW_KEY_IN_QUERY`      | `false`            | Enable player-ready start-and-play links via `?key=`; disable if unused (key can leak into logs/history) |
| `ICECAST_SOURCE_PASSWORD` | `secret`           | Source auth (ffmpeg → Icecast)                                                                           |
| `ICECAST_ADMIN_PASSWORD`  | `admin`            | Admin API auth (internal polling; also used by the health probe)                                         |
| `ICECAST_MAX_LISTENERS`   | `2`                | Per-mount listener cap, enforced by Icecast alone                                                        |
| `STREAM_TTL_MINUTES`      | `15`               | Auto-stop after N minutes with zero listeners                                                            |
| `PROXY_FILE`              | `./proxy.json`     | **Host** path to the proxy list; mounted read-only into the container as `/app/proxy.json`               |
| `STREAMLINK_QUALITY`      | `audio_only,worst` | streamlink quality priority list                                                                         |
| `LOG_LEVEL`               | `info`             | log level — one of `debug`, `info`, `warn`, `error`, `fatal`                                             |

Container-internal ports are fixed and not configurable — see [DESIGN.md](DESIGN.md).

## Status and logs

Check application state through the public entry point (substitute your hostname and API key):

```bash
curl -i -H "Authorization: Bearer <your-api-key>" https://yts.example.com/api/state
```

Example healthy, idle response from a local build:

```json
{
  "streamlink": { "status": "stopped" },
  "ffmpeg": { "status": "stopped" },
  "icecast": { "status": "available", "state": "stopped", "listeners": 0 },
  "general": { "state": "idle", "url": null, "health": "ok" },
  "version": "dev",
  "commit": "unknown"
}
```

`general.state` is `idle`, `starting`, `streaming`, or `stopped`; `general.url` can retain the last requested URL after stopping. HTTP `200` means healthy, not necessarily playing audio; `503` means the application health verdict is `failure`. Release images also report their version and commit.

Probe the whole stack on the separate health port:

```bash
curl -i http://yts.example.com:8080/hc
```

The response reports `result`, `duration` (milliseconds), and an optional `error` per component, plus `version` and `commit`. HTTP `503` identifies a failing component; `429` means the health endpoint's 60 requests/minute per-client limit was exceeded.

For production diagnostics, run these commands from the repository directory with the same environment files and Compose override as deployment.

Check container status:

```bash
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  ps
```

Show recent logs for all components:

```bash
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  logs --tail=100 --timestamps stream icecast caddy health
```

Follow stream logs:

```bash
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  logs -f --tail=100 stream
```

For a local/source-built stack, omit `--env-file .env.release` and `-f docker-compose.release.yml`. Stream logs include attempt numbers, redacted proxies, process exit details, and stop reasons (`manual`, `replaced`, `process-exit`, `ttl`). Remove secrets and sensitive URLs before sharing logs or API error details.

## Troubleshooting

Use the full [status and log commands](#status-and-logs) above to inspect the relevant components. For configuration checks and credential changes, use the full [release deployment commands](#how-to-deploy).

| Symptom                             | Likely cause                                                            | What to check or do                                                                                                                                                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose refuses to start            | Missing proxy file or invalid certificate path                          | Create `proxy.json` from the template and edit it; check that certificate paths exist on the host. Run the configuration review command from [How to deploy](#how-to-deploy) locally to inspect mounts.                                                  |
| API returns `400`                   | Missing or unsupported YouTube URL                                      | Use a canonical `https://www.youtube.com/watch?v=<id>` URL. With extra query parameters, use `curl --get --data-urlencode "url=<youtube-url>"` so they remain part of the YouTube URL. See [accepted URL forms](DESIGN.md#33-youtube-url-compatibility). |
| API returns `401`                   | Missing or mismatched API key                                           | Send `Authorization: Bearer <key>` matching `.env`; query authentication is disabled by default. After changing credentials, recreate the affected services with the deployment command.                                                                 |
| Start/stop returns `429`            | Another stream operation is still running                               | Wait for it to finish; inspect stream logs for slow startup or retry attempts before trying again.                                                                                                                                                       |
| Start returns `500`                 | YouTube block, unsuitable proxy, unavailable source, or Icecast failure | Read the response's `details` and stream/Icecast logs. Verify residential proxy access and Icecast credentials. After editing the proxy list, recreate the stream container using the command below, then start the stream again.                        |
| Audio URL returns `404`             | No active mountpoint                                                    | Check `/api/state`; start the stream if it is idle or stopped. `/stream` alone does not start playback.                                                                                                                                                  |
| Additional listeners cannot connect | Listener cap reached                                                    | Check `icecast.listeners` in `/api/state` and `ICECAST_MAX_LISTENERS` (default 2). Close another connection or raise the cap and recreate Icecast; then restart the audio stream.                                                                        |
| Health returns `503`                | A component failed or its probe timed out                               | Inspect the component's `error` and its logs. A stream probe `401` suggests mismatched API keys; an Icecast probe `401` suggests mismatched admin credentials.                                                                                           |
| Audio stops unexpectedly            | Source ended, process exited, or zero-listener TTL expired              | Check the `stream stopped` reason and preceding errors in stream logs. Fix the cause and issue another start request; stopped streams do not restart automatically.                                                                                      |
| Renewed certificate is not served   | Caddy still uses the old file mounts/certificate                        | Run the [renewal deploy hook](#renewing-certificates); it recreates Caddy with the production configuration.                                                                                                                                             |

After editing the proxy list, reload it by recreating only the stream container (this interrupts the active stream):

```bash
docker compose \
  --env-file .env \
  --env-file .env.release \
  -f docker-compose.yml \
  -f docker-compose.release.yml \
  up -d --no-deps --no-build --pull missing --force-recreate stream
```

For a local/source-built stack, omit `--env-file .env.release` and `-f docker-compose.release.yml`. Once the container is ready, issue a new start request.

## Development

Bun workspaces monorepo:

```
packages/
├── shared/   # yt-stream-shared — env Config used by both services
├── stream/   # the stream service
└── health/   # the health monitor
```

```bash
bun install
bun test          # runs the suites of all workspaces
bun run typecheck # tsc --noEmit
bun run lint      # oxlint
bun run format    # oxfmt
```

Per-workspace variants: `bun run test:stream`, `bun run lint:health`, etc.

## License

MIT
