# yt-stream

> Written by AI, driven and reviewed by a human.

A self-hosted service that turns a YouTube live stream or video into an Icecast-compatible MP3 audio stream. One `GET` request with a YouTube URL starts the stream and redirects you to a mountpoint playable by any radio receiver, VLC, or browser.

The service manages exactly **one stream at a time** — starting a new YouTube URL replaces the current one.

Architecture, design decisions, and security rationale are documented in **[DESIGN.md](DESIGN.md)**.

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

1. Create (or copy from example) `.env`

```bash
cp .env.example .env
```

2. Create the proxy list (mounted into the stream container; must exist before start — see [Proxies](#proxies)). The template ships example entries — **edit it before starting**: paste your own proxies, or empty it (`[]`) to connect directly

```bash
cp proxy.json.example proxy.json
```

3. Set `API_KEY` to protect `/api/stream` endpoints

```
# editing .env
API_KEY=<random-api-key-string>
```

4. Start the service

```bash
docker compose up -d --build
```

5. Wait for the stack to come up, then check health:

```bash
curl http://localhost:8080/hc
# {"caddy":{"result":"ok",...},"icecast":{"result":"ok",...},"stream":{"result":"ok",...}}
```

6. Start a stream (substitute `<your-api-key>` with API key set in `.env`)

```bash
curl -H "Authorization: Bearer <your-api-key>" \
  "http://localhost/api/stream?url=https://www.youtube.com/watch?v=<id>"
# 302 Found — Location: /stream
```

7. Open `http://localhost/stream` in VLC, a browser, or any radio client.
8. [Optional] Stop it manually (substitute `<your-api-key>` with API key set in `.env`):

```bash
curl -X DELETE -H "Authorization: Bearer <your-api-key>" http://localhost/api/stream
```

The stream also stops on its own:

- **TTL** — after `STREAM_TTL_MINUTES` (default 15) with **zero listeners**; a stream nobody listens to winds down by itself
- **Pipeline failure** — if streamlink or ffmpeg dies (bad URL, YouTube block, proxy down)
- **Replacement** — starting a new URL replaces the current stream

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

- Each start begins at a **random** list entry and its retry attempts (up to 3) advance to the **next** entry — a failed proxy is never retried through itself until the list wraps. The chosen proxy is logged (redacted) per attempt. Duplicate entries collapse at load; an empty list (`[]`) connects directly.

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
docker compose up -d --force-recreate caddy
```

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

All `/api/*` endpoints except `/api/state` require an API key: `Authorization: Bearer <key>` header, or `?key=<key>` query param when `ALLOW_KEY_IN_QUERY=true`.

| Method   | Path                                     | Auth | Purpose                                                            |
| -------- | ---------------------------------------- | ---- | ------------------------------------------------------------------ |
| `GET`    | `/api/stream?url=<youtube_url>`          | ✅   | Start a stream; `302` redirect to the audio mount                  |
| `DELETE` | `/api/stream`                            | ✅   | Stop the current stream                                            |
| `GET`    | `/api/state`                             | —    | Service status + health verdict (JSON); key-exempt by decision     |
| `GET`    | `/stream`                                | —    | Audio mount (Icecast, via Caddy) — play it in any client           |
| `GET`    | `/hc` (alias `/health`) on `HEALTH_PORT` | —    | Component health of caddy / icecast / stream; `503` if any is down |

Status codes for `GET /api/stream`: `302` success (redirect), `400` missing/invalid URL, `401` missing/invalid key, `429` another stream operation is in progress, `500` extraction/transcode/Icecast failure. `DELETE /api/stream` returns `200` (stopped), `404` (no active stream), or `429`.

## Configuration

Everything is configured via environment variables (see `.env.example`):

| Variable                  | Default            | Description                                                                                |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| `PUBLIC_BASE_URL`         | `http://localhost` | Public base URL — Caddy site address (`https://…` enables auto-HTTPS) and stream URLs      |
| `HTTP_PORT`               | `80`               | Host port → Caddy HTTP                                                                     |
| `HTTPS_PORT`              | `443`              | Host port → Caddy HTTPS                                                                    |
| `TLS_CERT_FILE`           | —                  | Host path to the full chain (leaf + intermediates); symlink resolved by Docker             |
| `TLS_KEY_FILE`            | —                  | Host path to the private key; both set → Caddy serves the pair, ACME skipped               |
| `HEALTH_PORT`             | `8080`             | Host port → health service                                                                 |
| `API_KEY`                 | `dev-api-key`      | API key for `/api/*` (dev fallback logs a startup warning)                                 |
| `ALLOW_KEY_IN_QUERY`      | `false`            | Allow `?key=` query auth (can leak into logs/history — keep off)                           |
| `ICECAST_SOURCE_PASSWORD` | `secret`           | Source auth (ffmpeg → Icecast)                                                             |
| `ICECAST_ADMIN_PASSWORD`  | `admin`            | Admin API auth (internal polling; also used by the health probe)                           |
| `ICECAST_MAX_LISTENERS`   | `2`                | Per-mount listener cap, enforced by Icecast alone                                          |
| `STREAM_TTL_MINUTES`      | `15`               | Auto-stop after N minutes with zero listeners                                              |
| `PROXY_FILE`              | `./proxy.json`     | **Host** path to the proxy list; mounted read-only into the container as `/app/proxy.json` |
| `STREAMLINK_QUALITY`      | `audio_only,worst` | streamlink quality priority list                                                           |
| `LOG_LEVEL`               | `info`             | pino log level                                                                             |

Container-internal ports are fixed and not configurable — see [DESIGN.md](DESIGN.md).

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
bun run lint      # oxlint
bun run format    # oxfmt
```

Per-workspace variants: `bun run test:stream`, `bun run lint:health`, etc.

## License

MIT
