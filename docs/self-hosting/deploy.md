# Deploying

## Docker Compose

`docker-compose.yml` and `Dockerfile` at the repository root run a complete public instance on one Linux host. There are five services:

| Service    | Image                                        | What it does                                                                                                                                          |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres` | `postgres:18-alpine`                         | The database.                                                                                                                                         |
| `client`   | `meowcord-server`, built from `Dockerfile`   | Runs before the server starts. Downloads the Discord web client into the `client` volume when it is empty, then exits.                                |
| `sfu`      | `meowcord-sfu`, the Go stage of `Dockerfile` | The pion SFU from `extra/pion-sfu`. It carries voice, video and Go Live media on a single UDP port.                                                   |
| `server`   | `meowcord-server`                            | The bundle: API, CDN, gateway, voice gateway and the web client, all on port 3001 inside the compose network.                                         |
| `caddy`    | `caddy:2-alpine`                             | Optional, see below. Terminates TLS with automatic certificates, serves HTTP/1.1, HTTP/2 and HTTP/3, compresses responses and proxies the websockets. |

`meowcord-server:latest` and `meowcord-sfu:latest` are local tags built from this checkout, not published images to download from Docker Hub. Their Compose services use `pull_policy: build` so Compose builds them from the Dockerfile instead of looking for those tags in a registry. The other images come from their existing Docker Hub repositories.

Caddy and the SFU publish ports to the internet. The server is also published on the host's loopback, `127.0.0.1:3001`, for a reverse proxy outside compose. Postgres is reachable inside the compose network and nowhere else.

### Before you start

- A Linux host with Docker Engine and the compose plugin.
- A DNS record for the instance's domain pointing at the host. Caddy asks Let's Encrypt for a certificate when it starts and keeps retrying until the record resolves.
- These ports open in the firewall: 80/tcp for the ACME challenge and the HTTPS redirect, 443/tcp, 443/udp for HTTP/3, and the voice port, 50000/udp unless you change `WRTC_PORT`.

### First start

```sh
git clone <this repository> meowcord && cd meowcord
cp .env.example .env
$EDITOR .env
docker compose up -d --build
```

On the first start the `client` service runs `scripts/client.js`, `scripts/e2ee-anchors.js`, `scripts/clan-badges.js` and `scripts/compress-client.js`, the same steps `bun run generate:client` runs. Equicord, the last step of `bun run generate:client`, is built into the image instead, from the pinned commit in `client/vencord.json` and the plugins in `client/plugins`. The download is about 300 MB and 12,000 files, and compressing them takes another minute. Nothing from Discord ends up in the image or in git. Follow it with:

```sh
docker compose logs -f client
```

The server starts when the client service has exited, and Caddy, when it's enabled, starts when the server answers `/readyz`, `/api/ping` and `/login`. `docker compose ps --all` shows the client service as exited successfully and the long-running services as healthy once the instance is up. Open `https://<DOMAIN>/register` to make the first account.

When `docker compose` runs from a checkout that also has a development `.env`, pass the production file explicitly with `docker compose --env-file prod.env ...`, because compose reads `.env` from the project directory by default.

### Health checks

The Compose healthcheck requires database readiness at `/readyz`, the API ping and the login page, with a three-second deadline on each parallel request. `/readyz` runs `SELECT 1`, returns 503 on failure or after two seconds and shares one outstanding query across concurrent requests. A timed-out query keeps that slot until it settles, so probes do not pile up while the pool is exhausted. `/healthz` and `/api/ping` do not check the database.

### Environment

Fresh installations use `POSTGRES_USER=meowcord`, `POSTGRES_DB=meowcord` and `MEOWCORD_VOLUME_PREFIX=meowcord`. Existing installations should retain their current values or leave these absent for compatibility.

Every variable lives in `.env`. `.env.example` lists all of them.

| Variable                                             | Required | Meaning                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN`                                             | yes      | Host name the instance is served on, such as `chat.example.com`. Caddy requests the certificate for it and the server builds every public URL from it.                                                                                                                                                                                               |
| `POSTGRES_PASSWORD`                                  | yes      | Password of the configured database user. It goes into a connection URL, so stick to letters and digits, `openssl rand -hex 24` for example. Postgres only reads it when the volume is empty, so changing it later also needs `ALTER USER` inside Postgres.                                                                                          |
| `WRTC_PUBLIC_IP`                                     | yes      | Public IPv4 address clients send voice and video to. The SFU announces it in its ICE candidates. Behind NAT, use the outside address and forward the voice port to the host. A host name works too. The SFU and the server resolve it to its IPv4 address when they start.                                                                           |
| `WRTC_PORT`                                          | no       | UDP port for all media, 50000 by default. It is published on the host under the same number, because the SFU announces the port it listens on.                                                                                                                                                                                                       |
| `INSTANCE_NAME`                                      | no       | Name shown in the client, emails, the developer portal and the status page. Sets `general.instanceName` and `client.instanceName` on the first start, and again whenever you change it here. In between, a name set in the admin panel stays.                                                                                                        |
| `COMPOSE_PROFILES`                                   | no       | `caddy` starts the bundled Caddy service, as `.env.example` sets it. Leave it empty to run the stack without Caddy and put your own reverse proxy in front, see [Without the bundled Caddy](#without-the-bundled-caddy).                                                                                                                             |
| `SERVER_PORT`                                        | no       | Port on `127.0.0.1` the server is published on for your own reverse proxy, 3001 by default.                                                                                                                                                                                                                                                          |
| `CADDY_GLOBAL_OPTIONS`                               | no       | One line added to Caddy's global options block. `local_certs` makes Caddy sign the certificate with its own CA, for testing without a public domain. `email you@example.com` sets the ACME account email.                                                                                                                                            |
| `TRUSTED_PROXIES`                                    | no       | Express `trust proxy` value for `security.trustedProxies`. The default, `uniquelocal`, trusts the private ranges Docker networks use, so the server reads the client address Caddy puts in `X-Forwarded-For`.                                                                                                                                        |
| `CAP_INSTANCE_URL`, `CAP_SITE_KEY`, `CAP_SECRET_KEY` | no       | A [Cap Standalone](https://capjs.js.org/guide/standalone/) server, the site key and its secret. Cap Core is enabled by default and needs no external server. With all three set, startup selects Standalone mode for registration. The server verifies at `<CAP_INSTANCE_URL>/<CAP_SITE_KEY>/siteverify`, and the browser has to reach the same URL. |
| `SMTP_HOST`                                          | no       | Turns on email through SMTP. Without it the instance sends no email, and signup only needs a username and a password.                                                                                                                                                                                                                                |
| `SMTP_PORT`                                          | no       | 465 when `SMTP_SECURE=true`, otherwise 587.                                                                                                                                                                                                                                                                                                          |
| `SMTP_SECURE`                                        | no       | `true` for implicit TLS, usually on port 465.                                                                                                                                                                                                                                                                                                        |
| `SMTP_STARTTLS`                                      | no       | Without `SMTP_SECURE`, the connection requires STARTTLS unless this is `false`.                                                                                                                                                                                                                                                                      |
| `SMTP_USERNAME`, `SMTP_PASSWORD`                     | no       | SMTP login.                                                                                                                                                                                                                                                                                                                                          |
| `EMAIL_FROM`                                         | no       | Sender address. Defaults to `noreply@<DOMAIN>`.                                                                                                                                                                                                                                                                                                      |
| `CLIENT_CONCURRENCY`                                 | no       | Parallel downloads when the client service fetches the web client, 8 by default.                                                                                                                                                                                                                                                                     |
| `LOG_REQUESTS`                                       | no       | Status codes the server logs requests for, `500,501` by default.                                                                                                                                                                                                                                                                                     |
| `REVISION`, `REVISION_TIME`                          | no       | Commit hash and commit time in Unix seconds, written to `.rev` in the image so the server reports which commit it runs. Fill them with `git rev-parse HEAD` and `git log -1 --format=%ct`.                                                                                                                                                           |

`E2EE_RECOVERY_MASTER_KEY` overrides the recovery key file when nonempty. `E2EE_RECOVERY_KEY_FILE` selects a path inside the server container; keep it under `/data/state` so the existing state volume persists it. Empty values use the default persistent `/data/state/.e2ee-recovery.key`. Do not change the master key after recovery records exist. A host path does not automatically mount into the container.

### Configuration file

The server keeps its configuration in `/data/state/config.json` in the `state` volume. Before every start, `scripts/docker-configure.js` writes the values that come from the environment into it: the public endpoints for the API, CDN and gateway, the voice region endpoint `<DOMAIN>/voice`, the trusted proxies, and, when their variables are set, the instance name, Cap and SMTP. Everything else in the file stays as you or the admin panel left it. To change another setting, edit the file and restart the server:

```sh
state_volume=$(bun scripts/ops/compose-resource.mjs state)
docker run --rm -it -v "$state_volume:/state" alpine vi /state/config.json
docker compose restart server
```

Unsetting `CAP_*` or `SMTP_*` later leaves the old values in the file. To return to local Cap Core, choose Cap Core in the admin dashboard and leave the Standalone environment variables empty. Change SMTP settings in the dashboard or configuration file.

### Unix event transport

`EVENT_TRANSMISSION=unix` uses `EVENT_SOCKET_PATH` as a writable shared directory. The directory must support Unix sockets and hard links. Each reader advertises a `.sock` name linked to its private bound socket. Native close removes the private path, and cleanup removes the advertised name only when its socket identity still matches. A replacement reader's socket is preserved. Startup probes existing socket paths and refuses to replace an active listener.

Each Unix writer retains at most 1,024 events or 16 MiB of encoded frames across offline backlog, queued publications and active writes. Admission snapshots the payload and rejects overflow with `IPC_QUEUE_FULL` without evicting accepted events. Capacity is released after write callbacks settle. These limits count retained frames, not kernel buffers or copies per recipient. Offline admission is not durable delivery; final cleanup discards undelivered backlog.

The `rabbitmq-single` writer also limits pending publications to 1,024 events or 16 MiB of encoded payloads. It snapshots each payload at admission and rejects overflow with `IPC_QUEUE_FULL`. Publications run in admission order, waiting for channel drain after backpressure before publishing the next event. Failures release their reservations and do not block later queued publications. These limits do not bound broker queues, and ordinary channel publication is not a broker confirmation.

The legacy RabbitMQ adapter uses the same pending-publication limits and ordered drain. It snapshots data and event type, propagates publication failures and retries channel setup at most once. A buffered publication is already accepted by the channel and is never resent if drain fails. Stopping and final close wait for admitted work before broker cleanup; final close rejects later admissions.

### Data

| Volume                       | Holds                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`                   | The database.                                                                                                                                                                                |
| `state`                      | `config.json`, `jwt.key` and `jwt.key.pub`, the recovery master key `.e2ee-recovery.key`, managed sender keys in `.e2ee-system` and queued encrypted announcements in `.announcement-spool`. |
| `storage`                    | Everything the CDN stores: attachments, avatars, icons, emojis and stickers.                                                                                                                 |
| `client`                     | The downloaded web client and its Brotli and gzip copies. It can be rebuilt.                                                                                                                 |
| `sfu`                        | The unix socket the server and the SFU talk over.                                                                                                                                            |
| `caddy_data`, `caddy_config` | Certificates, the ACME account and Caddy's internal CA.                                                                                                                                      |

Losing `state` signs every user out and loses the keys required for password-based encrypted account recovery, managed Official conversations and queued announcements. Account recovery refuses to replace a missing recovery key when recovery records already exist. Restore the matching state backup instead of generating replacement keys. Back up `postgres`, `state` and `storage` together while the server is stopped. This prevents uploads, recovery keys and queued announcements from changing between the database dump and the file archive. Leave Postgres running for the dump. Restart the server only after both commands succeed:

```sh
mkdir -p dump
scripts/ops/backup.sh "dump/backup-$(date +%Y%m%d-%H%M%S)"
```

The helper resolves the database user, database and actual state and storage volume names from `docker compose config`. It refuses an existing backup directory, writes a custom PostgreSQL dump, preserves file ownership and saves SHA256 checksums. A failed backup leaves the server stopped. The example writes under gitignored `dump/`. Keep each backup directory together and protect it as secret material. These commands assume this server is the only writer.

Restore into an isolated deployment with its own empty database and empty state and storage volumes. Start PostgreSQL and create those file volumes before restoring. Set the target deployment's Compose environment, then run the helper from its checkout:

```sh
scripts/ops/restore.sh /absolute/path/to/backup-directory
docker compose start server
```

The restore helper verifies checksums, stops the target server and refuses a populated public database schema or nonempty file volumes. It restores the dump in one transaction and restores matching signing keys, recovery keys, managed sender keys, queued announcements and attachments. A failed restore leaves the server stopped. Inspect the restored files and database before starting it. Named volumes use `MEOWCORD_VOLUME_PREFIX`, independent of the Compose project name.

### Updating

```sh
git pull
REVISION=$(git rev-parse HEAD) REVISION_TIME=$(git log -1 --format=%ct) docker compose build
docker compose up -d
```

Migrations run when the server starts. The web client in the `client` volume stays the same across updates, because the client service only downloads it when the volume is empty.

### Updating the web client

```sh
(
    set -e
    client_volume=$(bun scripts/ops/compose-resource.mjs client)
    client_backup="client-$(date +%Y%m%d-%H%M%S).tar.gz"
    docker compose stop server
    docker run --rm -v "$client_volume:/data/client:ro" -v "$PWD":/backup alpine \
        tar czf "/backup/$client_backup" -C /data/client cache cache_compressed
    docker compose run --rm client client --force
    docker compose start server
)
```

This fetches whatever build discord.com serves at that moment. Our Equicord plugins and `client/e2ee` find their targets in Discord's code by pattern, and `client/release.json` pins the build they were last checked against, see [client-patches.md](../development/client-patches.md#reviewed-client-releases). A newer build can break some of them. The client service fails when the mandatory encryption anchors are missing, including when it reuses a cached client. Server startup checks them again before accepting traffic. The update commands stop the server before modifying the shared cache and restart it only after validation succeeds. A failed download or anchor check leaves the server stopped. Retain the timestamped archive until the new client passes native browser and patch checks. To restore it, replace the archive name below with the file from that update:

```sh
(
    set -e
    client_volume=$(bun scripts/ops/compose-resource.mjs client)
    docker compose stop server
    docker run --rm -v "$client_volume:/data/client" -v "$PWD":/backup:ro alpine \
        tar xzf /backup/client-TIMESTAMP.tar.gz -C /data/client
    docker compose run --rm client
    docker compose start server
)
```

Restoration overwrites the tested index and its assets. Extra files from the failed download remain unreferenced. The anchor check validates encryption hook signatures, not full Vencord compatibility or successful encrypted browser conversations. Run the client and encryption checks from the contributing guide before inviting users back.

To run exactly the client you tested in development, copy your local cache into the volume instead of fetching:

```sh
(
    set -e
    docker compose stop server
    client_volume=$(bun scripts/ops/compose-resource.mjs client)
    client_backup="client-$(date +%Y%m%d-%H%M%S).tar.gz"
    docker run --rm -v "$client_volume:/data/client:ro" -v "$PWD":/backup alpine \
        tar czf "/backup/$client_backup" -C /data/client cache cache_compressed
    docker run --rm -v "$client_volume:/data/client" -v "$PWD/assets/cache":/src:ro alpine cp -a /src/. /data/client/cache/
    docker run --rm -v "$client_volume:/data/client" alpine chown -R 1000:1000 /data/client
    docker compose run --rm client
    docker compose start server
)
```

Without `--force`, the client service keeps the files it finds and only writes the missing compressed copies.

### Automatic updates

Use `UPDATE_CLIENT=0` and update the client manually with the stopped-server procedure above. Automatic client updates currently modify the shared cache before encryption compatibility validation and do not atomically restore the previous cache on validation failure. They can affect a running instance even when the update command fails.

`scripts/auto-update.sh` checks for code and, unless disabled, client updates. Each run:

1. Fetches the checked out branch and fast-forwards to its upstream. When there are new commits it rebuilds the images. A failed build moves the checkout back to the running commit, so the next run tries again, and the running server stays as it is. A checkout with local commits that can't fast-forward is left alone.
2. Reads the build discord.com serves from its `/app` page and compares it with the one in the `client` volume. When they differ it runs the client service with `--force`. The client script publishes the new `index.html` after downloading assets, before the entrypoint validates encryption anchors. This automatic path does not provide the stopped-server and backup guarantees of the manual procedure.
3. Runs `docker compose up -d` after a rebuild, or restarts only the server after a new client, then waits up to 5 minutes for `/api/ping`.

A lock keeps two runs from overlapping. The script exits with 1 when something failed. Run it once by hand from the repository, then add it to the crontab of a user who can run `docker`:

```sh
UPDATE_CLIENT=0 ./scripts/auto-update.sh
crontab -e
```

```cron
# every 6 hours, at minute 17
17 */6 * * * UPDATE_CLIENT=0 /home/fosscord/meowcord-server/scripts/auto-update.sh >> /home/fosscord/fosscord-update.log 2>&1
```

The script reads these optional environment variables, which go in front of the command in the crontab line:

| Variable         | Use                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `ENV_FILE`       | The compose env file when it isn't `.env`, for example `ENV_FILE=prod.env`.                           |
| `UPDATE_CODE`    | `0` to only keep the web client current and leave the code as you deploy it.                          |
| `UPDATE_CLIENT`  | `0` to only update the code.                                                                          |
| `SERVER_PORT`    | The server's port on the host's loopback, if you changed it from 3001.                                |
| `NOTIFY_WEBHOOK` | A Discord or Fosscord webhook URL that gets a message when something was updated or an update failed. |

A new Discord build can break Vencord patches or the e2ee anchors, as described above. With `NOTIFY_WEBHOOK` set you hear about every client update and can check the instance afterwards. Set `UPDATE_CLIENT=0` to stay on a build you tested.

### Voice and video

The server talks to the SFU over `/run/sfu/sfu.sock` in the shared `sfu` volume. If the SFU restarts, the server closes the voice connections of the calls that were running with code 4015, the code Discord uses for a crashed voice server, and reconnects to the new SFU. The SFU accepts one server connection, so leave `THREADS` unset in the server environment.

Clients send media straight to `WRTC_PUBLIC_IP:WRTC_PORT` over UDP, so that address has to be reachable from the internet. There is no TURN server, so a client behind a firewall that blocks outgoing UDP cannot join calls. `WRTC_PUBLIC_IP` is an IPv4 address or a host name. A host name is resolved to its IPv4 address once, when the SFU and the server start. The server retries a failed lookup for 15 seconds and then starts without voice. The SFU gives the lookup 10 seconds and then exits. After the address behind the name changes, restart both so they announce the new one.

### Without the bundled Caddy

The `caddy` service only starts with the `caddy` profile. To use a reverse proxy that already runs on the host, such as a system Caddy or nginx, leave `COMPOSE_PROFILES` empty in `.env`, so `docker compose up -d` starts everything except Caddy. Point the proxy at `127.0.0.1:3001`, or `SERVER_PORT` if you changed it. It has to pass websocket upgrades through, which Caddy's `reverse_proxy` does on its own. For a system Caddy, `docker/Caddyfile` works with `server:3001` replaced by `localhost:3001`. `stream_close_delay` needs Caddy 2.7 or newer, so drop that line on older versions.

The proxy connects through Docker's bridge network, whose addresses are in the private ranges the default `TRUSTED_PROXIES` trusts, so the server still reads the client address from `X-Forwarded-For`. Ports 80 and 443 are then the proxy's business. The voice port still has to be open, because media goes straight to the SFU.

A stack that was running with Caddy keeps the container around after the profile is turned off. Remove it with `docker compose --profile caddy rm -sf caddy`.

### Trying it locally

Caddy's internal CA and a made-up domain are enough to run the whole stack on one machine:

```sh
cat > local.env <<EOF
DOMAIN=fosscord.test
POSTGRES_PASSWORD=local
WRTC_PUBLIC_IP=127.0.0.1
COMPOSE_PROFILES=caddy
CADDY_GLOBAL_OPTIONS=local_certs
EOF
docker compose --env-file local.env up -d --build --wait
docker compose --env-file local.env cp caddy:/data/caddy/pki/authorities/local/root.crt caddy-root.crt
curl --cacert caddy-root.crt --resolve fosscord.test:443:127.0.0.1 https://fosscord.test/api/ping
```

For a browser, add `127.0.0.1 fosscord.test` to `/etc/hosts` and trust `caddy-root.crt`, or start Chromium with `--host-resolver-rules="MAP fosscord.test 127.0.0.1" --ignore-certificate-errors`.

## Client assets

The bundled web client lives in `assets/cache` and is written by `bun run generate:client`. That command also runs `scripts/compress-client.js`, which writes a Brotli (quality 11) and a gzip copy of every JS, CSS, JSON, SVG and WASM file to `assets/cache_compressed`. The server picks the best encoding the browser accepts and falls back to compressing on the fly only for files that have no up-to-date copy.

If the cache was generated before the compression step existed, run it once by hand:

```sh
bun scripts/compress-client.js
```

`bun scripts/client.js --missing` keeps the cached `index.html` and only downloads assets the cached build references but the cache lacks, such as the WebAssembly modules webpack loads by hash (`<hash>.module.wasm`). Run it when `assets/cacheMisses` lists files the client asked for and the server had to fetch from Discord.

The compression script only recompresses files whose source changed, so rerunning it is cheap. `CLIENT_CACHE_PATH` and `CLIENT_COMPRESSED_PATH` override the input and output directories. The server reads `CLIENT_COMPRESSED_PATH` too.

With `NODE_ENV=production`, hashed asset names are served with `Cache-Control: public, max-age=31536000, immutable` and the HTML page with `no-cache` and an ETag. In development everything is `no-cache`.

## Phones and tablets

The official Discord apps for Android and iOS can't be pointed at another server, so on a phone people use the instance in the browser. The web client has a phone layout of its own and switches to it when the user agent belongs to a phone or tablet. The server and channel lists sit in a drawer behind the menu button, settings open full screen, and the message box has a send button. On Android it's a plain text area and on iOS the usual rich editor. Login, registration, invites and server templates all fit the screen.

The stock client sent phones to the Discord app in two places, and `FosscordMobileWeb` (`client/plugins/fosscordMobileWeb`) fixes both:

- Invite and template links rendered a page whose only button opened `discordapp.onelink.me`, which hands off to the Discord app or the app store. The plugin renders the invite and template pages desktop browsers get, so the invite is accepted and the server is created right in the browser. Below 486 pixels it also stacks the two columns of the template page.
- Discord enables voice only for browsers its browser detection names Chrome, Firefox, Opera, Safari or Microsoft Edge. On Android that library reports `Chrome Mobile`, `Firefox Mobile`, `Opera Mobile` or `Samsung Internet`, so a tap on a voice channel did nothing. The plugin drops the ` Mobile` suffix and treats Samsung Internet as the Chrome version in its user agent. iOS Safari already passed.

`FosscordNoAppUpsells` removes the download prompts on every platform, phones included.

The server also rewrites Discord's viewport tag to add `interactive-widget=resizes-content`. With it, Chrome and Firefox on Android shrink the page when the on-screen keyboard opens instead of sliding it up, so the channel header stays visible above the message box. Safari ignores the key.

### Installing to the home screen

The client page links `/manifest.webmanifest`, which has the instance name from `client.instanceName`, `/app` as the start page, `display: standalone` and icons at 192 and 512 pixels. `/assets/pwa/icon-180.png`, `icon-192.png` and `icon-512.png` draw the instance icon (`client.icon`, then `general.image`, then `assets/icon.png`) at 62% of the width on `#121214`, the colour of the client's title bar. The margin keeps the icon inside the circle Android crops maskable icons to, so the manifest offers the same images for both the `any` and `maskable` purposes. iOS takes the 180 pixel version from the `apple-touch-icon` link and the name from `apple-mobile-web-app-title`. The server draws the icons with jimp, an optional dependency, and keeps them in memory per icon and size. An icon jimp can't read, such as an SVG or WebP file, falls back to `assets/icon.png`.

Browsers only offer to install a site served over HTTPS or from localhost. In Chrome or Samsung Internet on Android, open the browser menu and choose "Add to Home screen" or "Install app". On iOS, tap Share in Safari and choose "Add to Home Screen". The installed app opens without browser chrome and needs a connection, because there's no service worker cache for offline use.

## HTTPS and HTTP/2 without a proxy

Set `TLS_CERT` and `TLS_KEY` to PEM files and set `HTTPS_PORT` to a port different from `PORT` to serve HTTPS with HTTP/2. The default shared-port configuration currently fails TLS negotiation under Bun; use the separate port or put Caddy in front of plain HTTP. Gateway websockets use HTTP/1.1 upgrades. Shutdown closes the separate HTTPS listener and drains HTTP/2 sessions before database cleanup.

```sh
TLS_CERT=/etc/ssl/meowcord.pem TLS_KEY=/etc/ssl/meowcord.key HTTPS_PORT=443 bun run start
```

## Behind Caddy

Caddy gives HTTP/2 and HTTP/3 with automatic certificates. Its `reverse_proxy` passes websocket upgrades through, and `encode` skips responses that already carry a `Content-Encoding`, so the precompressed Brotli assets reach the browser as they are while Caddy compresses API responses with zstd or gzip. Stock Caddy has no Brotli encoder, and `encode br` fails to load without the `caddy-cbrotli` plugin.

```caddyfile
chat.example.com {
    encode zstd gzip
    reverse_proxy localhost:3001
}
```

`docker/Caddyfile` is the configuration the compose stack uses. It also keeps websockets on `/`, `/voice` and `/remote-auth` open for five minutes when Caddy reloads its configuration.

HTTP/3 needs UDP port 443 open in the firewall. Point `security.trustedProxies` in the config at Caddy's address and set `security.forwardedFor` to `X-Forwarded-For`, so rate limits, sessions and the gateway see the real client IP. Set the public endpoints (`api.endpointPublic`, `cdn.endpointPublic`, `gateway.endpointPublic`) to the `https://` and `wss://` URLs, and the voice region endpoint in `regions.available` to `<domain>/voice`.

## Upgrading the Compose project name

The Compose project and local images are named Meowcord. Before starting the renamed stack on an existing default installation, stop the old project without deleting its volumes:

```sh
docker compose -p fosscord down
docker compose up -d --build
```

Keep your existing `.env`. When the new database and volume variables are absent, Compose uses the existing `fosscord` database user, database and volume prefix. Fresh installations copied from `.env.example` use `meowcord` for each. Do not add the fresh-install values to an existing deployment: that would select different volumes or credentials. An installation with a custom old project name must set `MEOWCORD_VOLUME_PREFIX` to that old name before the switch. This preserves the database, attachments, encryption recovery key and cached client.

An exited client container with status 0 is expected. An unhealthy server is a failure. Inspect it with `docker compose logs --tail=100 server` and `docker inspect --format '{{json .State.Health}}' meowcord-server-1`. The healthcheck requires PostgreSQL readiness and successful API and login responses.

## Shutdown

The server drains lifecycle work on SIGTERM and SIGINT. The cluster supervisor forwards shutdown to its workers and does not restart intentional exits. Compose allows 35 seconds for the server to stop; the process has a 30-second deadline that exits with status 1 when startup or cleanup cannot finish.

Accepted event callbacks and emit hooks return tracked promises across local, process, Unix-socket and both RabbitMQ transports. Finalization enters a callback-draining phase after component stopping and before database cleanup. It refuses unrelated new callbacks while draining accepted work and callbacks started by that work. Callback failures are isolated and logged without event payloads. Direct Unix and single RabbitMQ reader close also waits for its accepted callback promises. RabbitMQ receipt acknowledgements keep their existing timing. Concurrent finalization calls share completion, and recursive calls from finalization listeners do not dispatch cleanup again.

JWT key-file checks share one active restoration pass. A shutdown request cancels the periodic checker, and component stopping waits for accepted writes or makes one final missing-file check. Restoration writes the loaded signing keys, and initialization and restoration wait for both file writes to settle before reporting failure.

## JSON workers

Asynchronous JSON conversions start workers on demand. `JSON_WORKERS` accepts integers from 1 through 128; the default is the CPU count capped at 128. Synchronous conversion starts no workers. Accepted requests keep workers referenced until completion and participate in the shared callback drain. Idle workers are unreferenced and terminated during final cleanup. Worker failure or a 60-second request deadline rejects that worker's pending requests; future requests start a replacement. Cleanup reports termination failures.

JSON stream decoding preserves UTF-8 characters across byte chunks and rejects malformed bytes. Array enumeration parses one entry at a time; full-value decoding still buffers the full document. Web readers release locks and cancel unfinished input on errors or early return. File readers close on early return and respect `autoClose: false` after normal completion. Enumerable output uses backpressure, closes successful output and aborts failed output while preserving the original error. Undefined, function and symbol entries use JSON array null placeholders.

JSON worker deserialization transfers parsed values directly through structured clone. Numeric values match synchronous `JSON.parse`, including negative zero and overflow or underflow results. Serialization continues to return JSON text.

Each JSON worker pool accepts at most 1,024 pending requests across its workers. Overflow rejects with JSON_QUEUE_FULL before allocating a timeout or posting the request. Replies and request or worker failures release capacity. Accepted requests keep their existing 60-second timeout and drain before final worker cleanup. This count limit does not bound payload bytes.

Pending JSON deserialization requests also share a 128 MiB UTF-8 input budget per pool. Overflow rejects with JSON_QUEUE_FULL before posting a request or allocating its timer. Replies, parsing or transport failures and worker shutdown release those input-byte reservations. Serialization snapshots share this budget using weighted graph accounting: UTF-8 strings, property and reference metadata, array slots, container entries and backing buffers, with shared references counted once per request. Growable backing buffers reserve their maximum size. Admission snapshots run getters once and reject uncloneable values before allocating workers or timers. This is a logical input budget, not exact native wire size or total process memory; temporary snapshot allocations and decoded results are outside it.

Whole-value JSON decoding from file and web streams enforces the same 128 MiB UTF-8 ceiling while accumulating text, before worker admission. Split UTF-16 surrogate pairs count as their combined UTF-8 encoding. Oversized web input is cancelled and its reader lock released; oversized file input destroys and closes its stream. The ceiling applies per reader and across active whole-value and array-entry accumulators.

Incremental JSON array decoding caps each unfinished entry at 128 MiB of UTF-8 text before parsing or worker admission. The budget resets between entries, so an array can stream beyond 128 MiB in total. Input accumulates source segments rather than individual characters, and oversized entries close or cancel their readers. Active whole-value and array-entry accumulators share a 128 MiB retained-text budget. Completion, parse or source failure, cancellation and early return release their reservations. This aggregate accumulator budget is separate from the worker input budget; it does not bound decoded results or total process memory.

Whole-value and array-entry readers share a maximum of 1,024 active accumulator slots, including readers waiting for their first byte. Reader-count overflow rejects with JSON_QUEUE_FULL, cancels an unadmitted web source and destroys and closes an unadmitted file stream. Completion, failure, cancellation and early return release the slot. This count limit is separate from the worker request limit.

[image-decoding.md](../security/image-decoding.md) lists the limits on branding images and burst reaction palettes.

## Storage and privacy

Every local and S3 storage mutation reserves cumulative instance, cache and account capacity in PostgreSQL. Webhook and application uploads count toward their owner account. Startup inventories storage before accepting mutations and reconciles confirmed writes and deletes. Existing unowned files still count toward instance capacity. Configure `cdn.storageQuota` byte and object limits for available disk or the S3 budget. An ambiguous remote write keeps its reservation until its generation can be confirmed; it fails closed rather than freeing potentially occupied capacity. Back up the database together with the files.

Plaintext attachment URLs are bearer URLs by default: anyone who obtains a URL can download that file. Encrypted private attachments remain ciphertext. External media and metadata requests send their destination URLs, including query strings, to `cors.estrogen.delivery`. This proxy is an external service. The explicit media filter stores its setting but does not scan or blur attachments.

DM encryption uses server-assisted recovery by default. The operator can recover published backup secrets. Guild messages, earlier plaintext and per-message forward secrecy are outside this implementation; see [the encryption design](../features/e2ee.md).
