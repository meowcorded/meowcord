# Setup

This guide links to native Linux hosting and covers a Docker instance, a local development instance and the first operator account. [deploy.md](deploy.md) covers Compose hosting and shared deployment details.

## Native Linux

Follow [native.md](native.md) to run the server without Docker as a dedicated, non-login `meowcord` user. It provides a systemd service, separates root-owned application files from writable state, and covers local PostgreSQL, HTTPS, voice, operator provisioning, backups and updates. Use this path for a host installation; the development setup below creates test accounts and is intended for isolated testing.

## Docker

Install Docker with Compose, clone the repository and copy `.env.example` to `.env`. Choose a unique `MEOWCORD_VOLUME_PREFIX`, set a generated PostgreSQL password, your public `DOMAIN` and `WRTC_PUBLIC_IP`, then run:

```sh
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=100 server
```

This can take several minutes, after which the client container exits with code 0 after downloading and preparing the client.

For a local demo, use `DOMAIN=http://localhost:3001`, `WRTC_PUBLIC_IP=127.0.0.1`, `SERVER_PORT=3001`, a free UDP `WRTC_PORT` and an empty `COMPOSE_PROFILES`. Open `http://localhost:3001`. Public instances use HTTPS and the `caddy` profile, or their own reverse proxy. Open the chosen UDP media port for remote voice clients.

Existing installations keep their original volumes unless their volume prefix changes. Never run `docker compose down -v` against data you intend to keep. Stopping with `docker compose stop` preserves instance data.

## Development

Install Bun 1.4, local PostgreSQL, Git and `lsof`. Install Go for voice and Node.js for Equicord's upstream build. Start with a fresh clone or worktree without runtime configuration. Prepare the cached client once in the main checkout:

```sh
bun install --frozen-lockfile
bun run generate:client
mkdir -p ~/.cache/fosscord-tools
bun add --cwd ~/.cache/fosscord-tools playwright-core
bun run dev:setup 3001 meowcord_dev_3001
```

The setup creates a fresh database, installs dependencies, writes private configuration, builds, starts the server and seeds two accounts. The private DM starts empty until the browsers establish encryption; sample messages are posted only in the test server. Existing databases, runtime configuration and occupied API, voice or media ports are refused. Each additional worktree needs its own base port and database. Worktrees reuse the main checkout's ignored client cache.

The seed script needs an installed Chromium browser. macOS uses Brave when running the documented browser commands; set `CHROME_PATH` to your installed Chromium executable on other systems.

Open `http://localhost:3001/login`. Seeded emails are `tester@fosscord.test` and `friend@fosscord.test`; passwords are in the private `scripts/dev/.test-account` file. The legacy email domain is only fixture data. Run the server in your terminal with `bun start` if your execution environment stops background processes when its shell exits.

```sh
bun run build:src
bun run lint
bun run test
PORT=3001 bun scripts/dev/parity-probe.mjs
```

Only clear rate limits on the database you created for these tests. Encryption checks require `E2EE_TEST_DATABASE_NAME` to name that same isolated database. Use the browser and voice commands in [CONTRIBUTING.MD](../../CONTRIBUTING.MD) for changes affecting those features.

## Operator account

Register an ordinary account and copy its numeric account ID from the client with Developer Mode enabled. The first signup receives no special rights. Only someone with local access to the instance database can provision an operator. Operator accounts can access `/admin` and change instance policy, so grant this right only to an account you control.

For Docker, run:

```sh
docker compose exec server bun scripts/ops/operator.mjs grant <account-id>
```

For a local installation, run from the instance checkout so Bun loads its `.env`:

```sh
bun scripts/ops/operator.mjs grant <account-id>
```

The command validates that the account exists, is human and is active. It changes only the operator bit and preserves every other right. Sign in again after changing privileges. Repeating a command leaves the same rights in place. To remove operator access, replace `grant` with `revoke`. Revocation also works on disabled or deleted accounts. No password or token is printed.

## Source archive

The source archive includes Dockerfiles, Compose configuration, example configuration, source, source patches, tests and documentation. Run the setup or Docker commands to build and download runtime dependencies. Discord's cached client, Equicord build output, private configuration, test credentials and databases are excluded. The archive ships under AGPL-3.0-only; inherited contributors remain credited in the license and source headers.

After committing a clean release checkout, `bun run release:pack` writes a source archive and SHA256 checksum under `releases/`. It packages the committed revision and rejects tracked runtime configuration or cached client builds.
