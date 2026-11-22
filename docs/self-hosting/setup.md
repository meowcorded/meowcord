# Setup

This page runs a public instance with Docker Compose on one Linux host. [native.md](native.md) runs it without Docker, and [CONTRIBUTING.MD](../../CONTRIBUTING.MD#development) sets up a development instance.

## What Compose runs

| Service    | What it does |
| ---------- | ------------ |
| `postgres` | PostgreSQL 18, reachable only inside the Compose network. |
| `client`   | Downloads the Discord web client into the `client` volume on the first start, then exits with code 0. |
| `sfu`      | The Go media server from `extra/pion-sfu`, carrying voice, video and Go Live on one UDP port, plus the TURN relay. |
| `warp`     | Cloudflare WARP as a SOCKS5 proxy for fetches of user-chosen URLs. |
| `server`   | API, CDN, gateway, voice gateway and web client on port 3001, published on `127.0.0.1:3001`. |
| `caddy`    | Optional. TLS with automatic certificates, HTTP/1.1, HTTP/2 and HTTP/3. |

Compose builds the `meowcord-server` and `meowcord-sfu` images from this checkout, with Equicord at the commit pinned in `client/vencord.json`. Neither image is published.

## Requirements

- A Linux host with Docker Engine and the Compose plugin.
- A DNS record for the instance's domain that points at the host.
- Open ports: 80/tcp, 443/tcp, 443/udp, and 50000/udp for voice unless you change `WRTC_PORT`. With `TURN_SECRET` set, also 3478/udp, 3478/tcp and 49160 to 49200/udp.

## Install

```sh
git clone https://github.com/meowcorded/meowcord.git meowcord && cd meowcord
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f client
```

The client service downloads about 300 MB in 12,000 files, which takes several minutes. The server starts when the client service exits, and Caddy starts once the server is healthy. Then open `https://<DOMAIN>/register`. Nothing from Discord goes into the image or into git.

To use an env file other than `.env`, pass it to every `docker compose` command, as in `docker compose --env-file prod.env up -d`, and set `ENV_FILE=prod.env` for the scripts in `scripts/ops` and `scripts/auto-update.sh`.

## Environment

Compose passes these from `.env` and refuses to start without the first three. `.env.example` has all of them except the recovery key and the Shop catalogue variables.

| Variable | Meaning |
| --- | --- |
| `DOMAIN` | Host name of the instance, such as `chat.example.com`. The server builds every public URL from it. `http://localhost:3001` works for a local trial. |
| `POSTGRES_PASSWORD` | Letters and digits only, for example from `openssl rand -hex 24`. Postgres reads it only when its volume is empty, so changing it later also needs `ALTER USER`. |
| `WRTC_PUBLIC_IP` | Public IPv4 address or host name that clients send media to. Behind NAT, use the outside address and forward the voice port. A host name is resolved once at startup. |
| `WRTC_PORT` | UDP port for all media, 50000 by default. |
| `TURN_SECRET` | Secret for the TURN relay that carries your users' calls in servers on other instances, from `openssl rand -hex 32`. Empty refuses those calls. |
| `TURN_PUBLIC_IP`, `TURN_PORT`, `TURN_RELAY_PORT_MIN`, `TURN_RELAY_PORT_MAX` | `WRTC_PUBLIC_IP`, 3478, 49160 and 49200 by default. [federation.md](../features/federation.md#turn-relay) lists every relay variable. |
| `INSTANCE_NAME` | Name shown in the client, emails, developer portal and status page. It is applied on the first start and whenever you change it here, and otherwise a name set in the admin dashboard stays. |
| `POSTGRES_USER`, `POSTGRES_DB`, `MEOWCORD_VOLUME_PREFIX` | `meowcord` in `.env.example`, and `fosscord` when absent, the names older installations use. |
| `COMPOSE_PROFILES` | `caddy` starts the bundled Caddy. Empty means you run your own proxy. |
| `SERVER_PORT` | Port on `127.0.0.1` for your own proxy, 3001 by default. |
| `CADDY_GLOBAL_OPTIONS` | One line of Caddy global options, such as `email you@example.com` or `local_certs`. |
| `TRUSTED_PROXIES` | Express `trust proxy` value, `uniquelocal` by default, which covers Docker's private ranges. |
| `CAP_INSTANCE_URL`, `CAP_SITE_KEY`, `CAP_SECRET_KEY` | A [Cap Standalone](https://capjs.js.org/guide/standalone/) server, used only when all three are set. Otherwise the built-in Cap runs, see [signup.md](../features/signup.md). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_STARTTLS`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM` | Email over SMTP, off without `SMTP_HOST`. The port is 465 with `SMTP_SECURE=true` and 587 otherwise, STARTTLS is required unless `SMTP_STARTTLS=false`, and the sender is `noreply@<DOMAIN>` by default. |
| `PUBLIC_FETCH_PROXY`, `WARP_LICENSE_KEY` | `socks5://warp:1080` by default, and an optional WARP+ key. See [external-services.md](external-services.md#hiding-the-servers-address). |
| `E2EE_RECOVERY_KEY_FILE`, `E2EE_RECOVERY_MASTER_KEY` | The encryption recovery key's path inside the container, `/data/state/.e2ee-recovery.key` by default, or the key itself. Never change it once recovery records exist. |
| `CLIENT_CONCURRENCY` | Parallel downloads for the client service, 8 by default. |
| `LOG_REQUESTS` | Status codes whose requests the server logs, `500,501` by default. |
| `REVISION`, `REVISION_TIME` | Commit hash and commit time in Unix seconds, set as shown in [Updates](#updates). |

## Operator account

The first account gets no special rights. Register, turn on Developer Mode in the client, copy your numeric account ID and run:

```sh
docker compose exec server bun scripts/ops/operator.mjs grant <account-id>
```

Sign in again and open `/admin`. `revoke` removes the right, and other rights stay as they are. An operator controls the whole instance.

## Configuration file

The server and the admin dashboard share `/data/state/config.json` in the `state` volume. Before every start, `scripts/docker-configure.js` writes the public URLs, the voice endpoint `<DOMAIN>/voice`, the trusted proxies and, when their variables are set, the instance name, Cap and SMTP. Unsetting `CAP_*` or `SMTP_*` later leaves the old values, so change those in the dashboard. [CONTRIBUTING.MD](../../CONTRIBUTING.MD#configuration) lists the keys specific to Meowcord. To edit the file by hand:

```sh
state_volume=$(bun scripts/ops/compose-resource.mjs state)
docker run --rm -it -v "$state_volume:/state" alpine vi /state/config.json
docker compose restart server
```

## Your own reverse proxy

Leave `COMPOSE_PROFILES` empty and point your proxy at `127.0.0.1:SERVER_PORT` with websocket upgrades. For a system Caddy, use `docker/Caddyfile` with `server:3001` replaced by `localhost:3001`, and remove the `stream_close_delay` line on Caddy older than 2.7. A stack that ran with Caddy keeps its container until you run `docker compose --profile caddy rm -sf caddy`.

Outside Docker, the server can serve HTTPS and HTTP/2 itself on a port other than `PORT`, because TLS on the shared port fails under Bun:

```sh
TLS_CERT=/etc/ssl/meowcord.pem TLS_KEY=/etc/ssl/meowcord.key HTTPS_PORT=443 bun run start
```

## Voice

Clients send media straight to `WRTC_PUBLIC_IP:WRTC_PORT` over UDP, so a client whose network blocks outgoing UDP can't join calls on your instance. The TURN relay only carries calls in servers on other instances. Leave `THREADS` unset. When the SFU restarts, clients in running calls reconnect.

## Local trial

Set `DOMAIN=http://localhost:3001`, `WRTC_PUBLIC_IP=127.0.0.1`, a free `WRTC_PORT` and an empty `COMPOSE_PROFILES`, then open `http://localhost:3001`. To test TLS with a made-up domain and Caddy's own CA:

```sh
cat > local.env <<EOF
DOMAIN=meowcord.test
POSTGRES_PASSWORD=local
WRTC_PUBLIC_IP=127.0.0.1
COMPOSE_PROFILES=caddy
CADDY_GLOBAL_OPTIONS=local_certs
EOF
docker compose --env-file local.env up -d --build --wait
docker compose --env-file local.env cp caddy:/data/caddy/pki/authorities/local/root.crt caddy-root.crt
curl --cacert caddy-root.crt --resolve meowcord.test:443:127.0.0.1 https://meowcord.test/api/ping
```

For a browser, add `127.0.0.1 meowcord.test` to `/etc/hosts` and trust `caddy-root.crt`.

## Data and backups

| Volume | Holds |
| --- | --- |
| `postgres` | The database. |
| `state` | `config.json`, `jwt.key`, `jwt.key.pub`, `federation.key`, `.e2ee-recovery.key`, managed sender keys in `.e2ee-system` and queued announcements in `.announcement-spool`. |
| `storage` | Uploads and the cache of Discord assets. |
| `client` | The downloaded web client. |
| `sfu` | The socket between the server and the SFU. |
| `warp` | The WARP registration. |
| `caddy_data`, `caddy_config` | Certificates and Caddy's CA. |

Volume names start with `MEOWCORD_VOLUME_PREFIX`. **Losing `state` signs everyone out and loses the keys for encrypted account recovery, managed Official conversations and queued announcements.** Never run `docker compose down -v` on data you want to keep.

```sh
mkdir -p dump
scripts/ops/backup.sh "dump/backup-$(date +%Y%m%d-%H%M%S)"
```

The script stops the server, dumps PostgreSQL, archives `state` and `storage` with SHA256 checksums and starts the server again. It refuses an existing directory and starts the server again when a step fails. The backup holds every key.

To restore, set up a separate deployment with an empty database and empty volumes, start its `postgres` service, and run from its checkout:

```sh
scripts/ops/restore.sh /absolute/path/to/backup-directory
docker compose up -d
```

The restore script checks the checksums, refuses a database or volume that has data and restores the dump in one transaction.

`cdn.storageQuota` caps storage at 100 GiB for the instance and 10 GiB per account by default, see [limits.md](../security/limits.md#storage-quotas).

## Updates

```sh
git pull
REVISION=$(git rev-parse HEAD) REVISION_TIME=$(git log -1 --format=%ct) docker compose build
docker compose up -d
```

Migrations run when the server starts. The client service only downloads into an empty volume, so the web client stays as it is. When an update changes the Discord build pinned in `client/release.json`, the containers refuse the old build until you refresh the client:

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

A failed download or check leaves the server stopped. To go back, restore the archive and run the client service without `--force`:

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

### Automatic updates

`scripts/auto-update.sh` fast-forwards the branch, rebuilds, runs `docker compose up -d` and waits up to 5 minutes for `/api/ping`. A failed build moves the checkout back, a checkout with local commits is left alone, and the script exits with code 1 when a step failed and nothing changed, or when the server doesn't answer after an update. Set `UPDATE_CLIENT=0`, because its client step downloads whatever build discord.com serves, without a backup.

```cron
17 */6 * * * UPDATE_CLIENT=0 /srv/meowcord/scripts/auto-update.sh >> /var/log/meowcord-update.log 2>&1
```

The script also reads `ENV_FILE`, `UPDATE_CODE=0` to skip the code, `SERVER_PORT` from its own environment and not from the env file, `NOTIFY_WEBHOOK` for a Discord-compatible webhook that gets each result, and `LOCK_FILE`.

## Optional content

### Shop catalogue

The free Shop lists `assets/collectibles.json` and `assets/profile-effects.json`, the JSON arrays that Discord's `collectibles-categories` and profile effects endpoints return. Neither file ships, so a new instance has an empty Shop. Mount them into the server service and restart it:

```yaml
    volumes:
      - ./assets/collectibles.json:/app/assets/collectibles.json:ro
      - ./assets/profile-effects.json:/app/assets/profile-effects.json:ro
```

Or set `COLLECTIBLES_EXTERNAL_REFRESH=true`, `COLLECTIBLES_CATALOG_URL` and `PROFILE_EFFECTS_CATALOG_URL` without read-only mounts. The server then downloads both every 12 hours, or every `COLLECTIBLES_REFRESH_HOURS`, and keeps the last good copy in memory. It also tries to save the copy in `assets`, which only lasts on a native install where that directory is writable. The admin dashboard's Shop catalogue card shows the source and the last error.

Catalogue URLs must return JSON arrays. Discord's authenticated API and a profile effects response wrapped in `profile_effect_configs` cannot be used directly. An archived catalogue is a snapshot, not a live copy of the current Shop.

### Steam avatar frames

The Shop's Steam category ships in `assets/steam-frames.json`, so it needs no setup. `bun scripts/steam-frames.mjs` refreshes it from Steam, and the CDN downloads each frame's art from Steam's CDN through `PUBLIC_FETCH_PROXY` the first time someone views it while `externalRequests.steamAssetFallback` is on, which is the default. See [steam-frames.md](../features/steam-frames.md).

### Standard stickers

Discord's standard sticker packs ship without artwork. To download the catalogue and artwork:

```sh
docker compose exec server bun scripts/provision-stickers.mjs --import-catalog
```

On a native install, run `DOTENV_CONFIG_PATH=/path/to/instance/.env bun scripts/provision-stickers.mjs --import-catalog` instead. The script reads `DATABASE` and `STORAGE_LOCATION` from the environment or from that file, and needs PostgreSQL and file storage. Rerun it to fetch what failed, and leave out `--import-catalog` when the packs exist. Edit packs on the Sticker packs page of the [admin dashboard](../features/admin.md). Without local artwork, the CDN fetches it from Discord while `externalRequests.discordStickerPacks` is on, which is the default.

## SQLite

A single-process instance can use SQLite through Bun's built-in driver instead of PostgreSQL:

```dotenv
DATABASE=sqlite:db/meowcord.sqlite
CONFIG_PATH=config.json
PORT=3001
```

Relative paths resolve from the working directory, and absolute ones such as `sqlite:/var/lib/meowcord/meowcord.sqlite` work too. Leave `THREADS` and `DB_SYNC` unset. Changing `DATABASE` doesn't copy data between backends. To back up, stop the server and copy the database with its `-wal` and `-shm` files, the configuration, the storage directory and the recovery key.

## Renamed Compose project

The Compose project used to be called `fosscord`. On an older installation, keep your existing `.env` and run:

```sh
docker compose -p fosscord down
docker compose up -d --build
```

Don't add the `meowcord` values from `.env.example`, because they select new, empty volumes. If the old project had a custom name, set `MEOWCORD_VOLUME_PREFIX` to it first.

## Troubleshooting

- The client container exited with code 0. That is expected.
- The server is unhealthy. Read `docker compose logs --tail=100 server`. The healthcheck needs `/readyz`, which answers only when the database does, plus `/api/ping` and `/login`, each within 3 seconds.
- Link previews fail. Check the Link previews card on the System page of the admin dashboard and [external-services.md](external-services.md#hiding-the-servers-address).
