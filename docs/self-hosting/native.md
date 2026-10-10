# Native Linux hosting

Run the bundle and voice SFU as a dedicated, non-login `meowcord` user under systemd. PostgreSQL and the HTTPS reverse proxy run as their own service users. Docker is not required. This guide is for a fresh Debian or Ubuntu host with systemd; it does not migrate an existing instance.

The application files belong to root. The `meowcord` account can write instance state and caches, but cannot replace the server, its dependencies or the Bun binary. Do not give this account sudo access or membership in the `docker` group.

## Prerequisites

Install the host packages with your administrator account:

```sh
sudo apt update
sudo apt install ca-certificates curl unzip git rsync openssl build-essential python3 pkg-config libssl-dev ffmpeg postgresql postgresql-client
sudo systemctl enable --now postgresql
```

Install Bun 1.4 from [Bun's installation guide](https://bun.sh/docs/installation) as your normal build user. Install Node.js for Equicord's upstream pnpm build and Go 1.24 or newer for the voice SFU. Check `extra/pion-sfu/go.mod` for the current Go requirement. Node.js is only needed at build time; Bun runs the server and repository scripts.

The service below uses `/usr/local/bin/bun`. Copy your installed Bun binary there as a root-owned executable, then check its version:

```sh
sudo install -o root -g root -m 0755 "$(command -v bun)" /usr/local/bin/bun
/usr/local/bin/bun --version
go version
```

Use a DNS name such as `chat.example.com` pointing to the host. Before starting the server, configure the host firewall to allow your administrative SSH access, 80/tcp and 443/tcp for the reverse proxy, and 50000/udp for voice. Allow 443/udp if the proxy serves HTTP/3. Deny remote access to 3001/tcp and 5432/tcp on both IPv4 and IPv6, while permitting loopback traffic.

The bundle currently listens on all interfaces on `PORT`; it has no loopback bind setting. Pointing the proxy at `127.0.0.1:3001` does not make that listener private. Verify from another machine that port 3001 is blocked before opening registration. Keep PostgreSQL's `listen_addresses` limited to localhost.

## Service account and directories

```sh
sudo useradd --system --user-group --home-dir /var/lib/meowcord --no-create-home --shell /usr/sbin/nologin meowcord
sudo install -d -o root -g meowcord -m 0750 /opt/meowcord /opt/meowcord/assets /etc/meowcord
sudo install -d -o meowcord -g meowcord -m 0700 /var/lib/meowcord /var/lib/meowcord/storage /var/cache/meowcord
```

If the account already exists, inspect it with `id meowcord` and `getent passwd meowcord` instead of recreating it. The paths have these roles:

| Path | Owner | Contents |
| --- | --- | --- |
| `/opt/meowcord` | `root:meowcord` | Compiled server, dependencies, scripts and static assets. Readable but not writable by the service. |
| `/etc/meowcord/meowcord.env` | `root:meowcord`, mode `0640` | Database credentials and runtime environment. |
| `/var/lib/meowcord` | `meowcord:meowcord`, mode `0700` | Configuration, JWT keys, encryption recovery key and attachment storage. |
| `/var/cache/meowcord` | `meowcord:meowcord`, mode `0700` | Cached client, compression output, cache miss log and detectable games cache. |
| `/run/meowcord` | Created by systemd | SFU IPC socket. Removed when the service stops. |

## PostgreSQL

Create a login role with no cluster administration rights, and a database owned by it:

```sh
sudo -u postgres createuser --no-superuser --no-createdb --no-createrole --pwprompt meowcord
sudo -u postgres createdb --owner=meowcord meowcord
```

Generate a password with `openssl rand -hex 24`, keep it in your password manager and enter the same value at the password prompt and in the environment file below. Hex characters need no escaping in the connection URL. These commands are for a new role and database; do not drop an existing database to rerun them.

Confirm local TCP password authentication works:

```sh
psql -h 127.0.0.1 -U meowcord -d meowcord -W -c 'SELECT 1'
```

If authentication fails, inspect PostgreSQL's `pg_hba.conf`. Use `scram-sha-256` for this role's loopback TCP connection, and reload PostgreSQL after changing it. Do not use `trust`. A typical matching rule is `host meowcord meowcord 127.0.0.1/32 scram-sha-256`. Rule order matters. See [PostgreSQL's authentication documentation](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html).

The server applies its migrations on startup. It needs ownership of its own database objects, not PostgreSQL superuser rights. Leave `DB_SYNC` unset.

## Build and install

Build in a separate checkout owned by your normal build user. Run dependency installation and client builds without sudo:

```sh
git clone https://github.com/meowcorded/meowcord.git meowcord-build
cd meowcord-build
bun install --frozen-lockfile
bun run build
bun run build:e2ee
bun run generate:client
bun run check:client
(cd extra/pion-sfu && go build -trimpath -o pion-sfu .)
```

`generate:client` downloads the pinned Discord client, validates encryption anchors, extracts server tag badges, builds Equicord and compresses the assets. Allow several minutes and enough disk for the checkout, dependencies, `.vencord` build tree, client cache and installed copy. These downloaded and built client files stay local and must never be committed or distributed.

From the build checkout, install the runtime files:

```sh
for directory in dist node_modules scripts client; do
    sudo rsync -a --delete "$directory/" "/opt/meowcord/$directory/"
done
sudo install -o root -g meowcord -m 0640 package.json /opt/meowcord/package.json
sudo rsync -a --delete --exclude=/cache --exclude=/cache_compressed --exclude=/cacheMisses --exclude=/detectable.json assets/ /opt/meowcord/assets/
sudo install -o root -g meowcord -m 0750 extra/pion-sfu/pion-sfu /opt/meowcord/pion-sfu
sudo chown -hR root:meowcord /opt/meowcord
sudo chmod -R u=rwX,g=rX,o= /opt/meowcord
sudo rsync -a --delete assets/cache/ /var/cache/meowcord/cache/
sudo rsync -a --delete assets/cache_compressed/ /var/cache/meowcord/cache_compressed/
sudo touch /var/cache/meowcord/cacheMisses
sudo sh -c 'test -f /var/cache/meowcord/detectable.json || printf "[]\n" > /var/cache/meowcord/detectable.json'
sudo chown -R meowcord:meowcord /var/cache/meowcord
sudo chmod -R u=rwX,go= /var/cache/meowcord
sudo ln -s /var/cache/meowcord/cache /opt/meowcord/assets/cache
sudo ln -s /var/cache/meowcord/cache_compressed /opt/meowcord/assets/cache_compressed
sudo ln -s /var/cache/meowcord/cacheMisses /opt/meowcord/assets/cacheMisses
sudo ln -s /var/cache/meowcord/detectable.json /opt/meowcord/assets/detectable.json
```

Create these four symlinks only on the first installation. The server locates its assets relative to `dist`, so they must remain under `/opt/meowcord/assets`. The cache symlinks provide writable targets without granting write access to the application tree. `dist/tsconfig.json` must be copied with `dist`; it supplies Bun's runtime import aliases.

## Runtime configuration

Create a private file, then edit it with `sudoedit`:

```sh
sudo install -o root -g meowcord -m 0640 /dev/null /etc/meowcord/meowcord.env
sudoedit /etc/meowcord/meowcord.env
```

Use these values, replacing the password, domain and example public IPv4 address:

```ini
NODE_ENV=production
PORT=3001
DATABASE=postgres://meowcord:REPLACE_WITH_HEX_PASSWORD@127.0.0.1:5432/meowcord
CONFIG_PATH=/var/lib/meowcord/config.json
STORAGE_LOCATION=/var/lib/meowcord/storage
E2EE_RECOVERY_KEY_FILE=/var/lib/meowcord/.e2ee-recovery.key
BUN_RUNTIME_TRANSPILER_CACHE_PATH=/var/cache/meowcord/bun
DOMAIN=chat.example.com
TRUSTED_PROXIES=loopback
WRTC_LIBRARY=pion
PION_SFU_BIN=/opt/meowcord/pion-sfu
PION_SFU_IPC=/run/meowcord/sfu.sock
WRTC_PUBLIC_IP=203.0.113.10
WRTC_PORT_MIN=50000
WRTC_PORT_MAX=50000
LOG_REQUESTS=500,501
```

Write literal values; systemd environment files do not expand `$VARIABLE` references. Do not copy the Compose environment unchanged: native hosting needs `DATABASE`, `PORT`, `WRTC_PORT_MIN` and `PION_SFU_BIN`, rather than Compose's database, host-port and separate SFU settings.

The existing `scripts/docker-configure.js` also works outside Docker. The service runs it before each start to set the public API, CDN, gateway and voice URLs, and to trust only the local proxy. It writes `config.json`, which the server fills with defaults and the admin dashboard can edit. Optional `INSTANCE_NAME`, SMTP and Cap variables supported by that script are described in [deploy.md](deploy.md#environment). The built-in Cap mode works without an external captcha service. External requests are controlled separately; see [external-services.md](external-services.md).

Leave `THREADS` and `WRTC_WS_PORT` unset. The bundle uses one server process and serves the voice websocket at `/voice` on port 3001. It starts and supervises the SFU as the same unprivileged user. Voice media uses 50000/udp directly, so behind NAT forward that port and announce the outside address in `WRTC_PUBLIC_IP`.

## systemd service

Save this as `/etc/systemd/system/meowcord.service`, owned by root with mode `0644`:

```ini
[Unit]
Description=Meowcord server
Wants=network-online.target
After=network-online.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=meowcord
Group=meowcord
WorkingDirectory=/var/lib/meowcord
EnvironmentFile=/etc/meowcord/meowcord.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStartPre=/usr/local/bin/bun /opt/meowcord/scripts/client-release.js --check
ExecStartPre=/usr/local/bin/bun /opt/meowcord/scripts/e2ee-anchors.js
ExecStartPre=/usr/local/bin/bun /opt/meowcord/scripts/docker-configure.js
ExecStart=/usr/local/bin/bun /opt/meowcord/dist/bundle/start.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=35
KillSignal=SIGTERM
KillMode=mixed
UMask=0077
RuntimeDirectory=meowcord
RuntimeDirectoryMode=0700
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/meowcord /var/cache/meowcord /run/meowcord
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
```

The writable paths cover configuration, signing and recovery keys, uploads, caches and SFU IPC. The working directory keeps `jwt.key` and `jwt.key.pub` in persistent state. `KillMode=mixed` gives the bundle time to stop its SFU before systemd kills remaining processes, and the 35-second timeout exceeds the server's 30-second shutdown deadline.

These restrictions also apply to the startup commands and SFU. Bun needs executable memory for its JavaScript engine, so do not add `MemoryDenyWriteExecute=true`. The service needs networking for PostgreSQL, HTTP, voice and configured external services; `AF_NETLINK` allows the SFU to enumerate local network interfaces. See [systemd's execution and sandboxing reference](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml) for the restrictions and their limits.

Validate and start:

```sh
sudo systemd-analyze verify /etc/systemd/system/meowcord.service
sudo systemctl daemon-reload
sudo systemctl enable --now meowcord
sudo systemctl status meowcord --no-pager
sudo journalctl -u meowcord -n 100 --no-pager
curl --fail http://127.0.0.1:3001/readyz
curl --fail http://127.0.0.1:3001/api/ping
curl --fail --output /dev/null http://127.0.0.1:3001/login
```

`/readyz` checks PostgreSQL; a listening process alone is not a successful startup. Use `sudo journalctl -u meowcord -f` for live logs and `sudo systemctl restart meowcord` after runtime environment changes. `systemctl daemon-reload` is needed after editing the unit itself. `systemd-analyze security meowcord.service` explains the unit's restrictions; its score does not verify application security.

## HTTPS and operator access

Install Caddy as a host service using [Caddy's installation instructions](https://caddyserver.com/docs/install). Keep its own service account and certificate storage. Put this in `/etc/caddy/Caddyfile`, replacing the domain:

```caddyfile
chat.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://chat.example.com/readyz
```

[Caddy passes websocket upgrades through](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). `TRUSTED_PROXIES=loopback` matches this local proxy. A proxy on another host needs a matching trusted address and firewall rules permitting only that host to reach the backend.

Open `https://chat.example.com/register`, register your account and copy its numeric ID with Developer Mode enabled. The first signup is an ordinary account. Grant operator rights with the explicit environment file:

```sh
sudo -u meowcord /usr/local/bin/bun --env-file=/etc/meowcord/meowcord.env /opt/meowcord/scripts/ops/operator.mjs grant ACCOUNT_ID
```

Replace `ACCOUNT_ID` with the numeric ID. Sign in again, then open `/admin`. Replace `grant` with `revoke` to remove operator access. A non-login shell does not prevent an administrator from running a specific command with `sudo -u meowcord`. Bun's [`--env-file` option](https://bun.sh/docs/runtime/environment-variables#manually-specifying-env-files) loads the credentials for this maintenance command.

## Backups and restore

Stop the service so the database and attachments do not change independently during the backup. Run these commands from your administrator account:

```sh
set -o pipefail
sudo systemctl stop meowcord
backup_dir="/var/backups/meowcord/$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -o root -g root -m 0700 "$backup_dir"
sudo -u postgres pg_dump -Fc meowcord | sudo tee "$backup_dir/database.dump" > /dev/null
sudo tar -czf "$backup_dir/state.tar.gz" -C / etc/meowcord var/lib/meowcord
sudo tar -czf "$backup_dir/client.tar.gz" -C / var/cache/meowcord
sudo chmod 0600 "$backup_dir/database.dump" "$backup_dir/state.tar.gz" "$backup_dir/client.tar.gz"
sudo systemctl start meowcord
```

Run the backup commands in Bash and check every command succeeds before calling the backup complete. Keep a copy of the installed application release and its build revision with the backup. Encrypt backups and copy them off the host. The state archive contains credentials, JWT keys, configuration and `.e2ee-recovery.key`; losing the recovery key breaks recovery of existing encrypted backups. The client archive preserves the tested Discord build. Do not treat it as a disposable download until the instance has a tested replacement.

Test restoration on a separate host and a fresh database. Stop its service, restore `/etc/meowcord`, `/var/lib/meowcord` and `/var/cache/meowcord`, install the matching application release and recreate the asset symlinks. Restore the dump as the `meowcord` database owner with `pg_restore --no-owner --role=meowcord` using a local PostgreSQL administrator connection. Restore file ownership and modes from this guide before starting. Never restore over a live database or generate replacement recovery keys for an existing instance.

## Updates

Build the chosen revision in the separate build checkout as your normal user. Run `bun install --frozen-lockfile`, `bun run build`, `bun run build:e2ee`, `bun run build:equicord` and the SFU build. To retain the current Discord build, keep the checkout's existing cache and run `bun scripts/e2ee-anchors.js`, `bun scripts/clan-badges.js`, `bun scripts/compress-client.js` and `bun run check:client` against it. A new checkout needs a copy of the installed caches for these checks.

For a deliberate client update, run `bun run generate:client` in that separate checkout and validate it with `bun run check:client` before installation. Do not run client generation against the live installed cache. The Compose auto-update script is not a native systemd updater.

Stop and back up the instance, preserving `/opt/meowcord` as the previous application release. Repeat the runtime-file installation commands from the build checkout, skipping the four existing symlinks. The `rsync --delete` commands remove stale compiled routes and dependencies; they must only target the documented application directories and client caches. Keep `/etc/meowcord` and `/var/lib/meowcord` intact. Reapply root ownership to the code and service ownership to the caches, start the service and repeat the local and HTTPS health checks. Check sign-in, encrypted DMs and a voice call before accepting the update.

If an update fails after database migrations, stopping the service and replacing code alone may not be sufficient. Restore the matching database, state, application release and client snapshot from the stopped-instance backup. Do not mix an old database with newer attachments or encryption keys.
