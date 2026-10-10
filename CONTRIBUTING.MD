# Contributing

**AI contributions are fully allowed during this alpha phase.** Please just use a frontier model like Opus 5.5, label them in your PR's description and test your code for vulnerabilities and bugs properly.

**Meowcord is not ready for human use.** Everything below is mostly just to get most stuff working during the alpha. Please do not host public instances unless they are specifically labelled as unstable and unofficial.

## Keeping track of features

* [docs/development/parity.md](docs/development/parity.md) lists 143 Discord features and what this server does with each one. Update this document as you work on them.

* [docs/features/admin.md](docs/features/admin.md) covers the instance dashboard and where its settings live. [docs/README.md](docs/README.md) indexes every doc.

## External services

Some partial features need something from outside the server. SMS, connections, linked roles, Spotify and the GIF picker need provider credentials the operator adds. Game detection only works in the desktop app, and the explicit media filter saves its setting but nothing scans attachments. The two features not started, local RPC rich presence and Clips, both need the desktop app.

Please do NOT add SMS support, quests, orbs, mentions to Nitro and boosting, upsells, download prompts, or any sponsored content. Nitro and all similar paid features are intentionally not included in the UI and should be free. The Equicord plugins in `client/plugins` remove them from the client. Please also do not add any PRs changing the README.

From the backend, every account has Premium (Nitro) and every server is boost level 3 with 33 boosts. Nothing can be bought, and every Shop item is free.

After changing signup verification, run `cap-signup-smoke.mjs` against your isolated core-mode instance in Chromium and with `BROWSER=webkit`. The native smoke submits twice before the first request settles and checks one HTTP request, correctable field errors, successful signup and proof replay rejection. Run `cap-disabled-smoke.mjs` in both browsers against an isolated instance with `register.disabled: true`, then with `register.allowNewRegistration: false` and `REGISTRATION_DISABLED_CODE=REGISTRATION_DISABLED`. It verifies visible policy errors, retained proof and fields, and no captcha modal. Focused request tests also hold a promise pending and verify release on responses and errors. Run `cap-accessibility-smoke.mjs` in both browsers for invalid-submit focus, keyboard solving, error descriptions and keyboard retry. Run `cap-disconnect-smoke.mjs` in both browsers to check real HTTP disconnects before registration and after account creation, fresh-proof retry and native sign-in recovery with the original password.

DMs and group DMs can be end-to-end encrypted. The design is in [docs/features/e2ee.md](docs/features/e2ee.md).

Signing up needs only a username and a password. Date of birth is optional, email is optional unless the operator requires it, and the operator can put a [Cap](https://capjs.js.org) captcha in front of registration, login and password reset. We are not looking for support for more CAPTCHAs at this moment.

The instance has its own status page at `/status`, an admin dashboard at `/admin` and Web Push notifications for users with no tab open.

Please do not leave any Markdown files or screenshots in the main repo. Leave them in docs, and screenshots in the gitignored docs/qa.

Use biome and two space indentation.

## Development

You need Bun 1.4, PostgreSQL (17 is what we run) and, for voice and video, Go 1.24 or newer. Bun installs the packages, runs the server and runs every script. The browser scripts below use `playwright-core` and Google Chrome or another Chromium build.

```sh
bun install
bun run generate:client
bun run dev:setup 3001 meowcord_dev_3001
```

`bun install` installs the dependencies from `bun.lock`, applies the fixes in `patches/` through `patchedDependencies` and points git at the pre-commit hook in `.githooks`. `bun run generate:client` downloads the Discord web client into `assets/cache`, compresses it and builds Equicord with our plugins into `assets/vencord`. The download is about 300 MB. Building Equicord uses Equicord's own pnpm toolchain, which needs Node.js, and the script requires the exact pinned pnpm version. It tries `pnpm` and `corepack pnpm`, then installs that version with Bun into `.vencord/tools` and invokes its Node entry point. This also works when Bun blocks pnpm's install scripts.

`worktree-setup.sh <port> <database>` does the rest. It writes `.env` and `config.json`, builds `extra/pion-sfu` when Go is installed, creates a new database as your system user on local PostgreSQL, builds the server, starts it and seeds two accounts with an empty encrypted DM and a server. It refuses existing databases, runtime `.env` files, `config.json` and occupied API, voice and media ports. Use a fresh worktree and a unique database name for another instance. It runs `bun install` in the checkout, and in a git worktree it symlinks `assets/cache`, `assets/cache_compressed` and `assets/vencord` from the main checkout, so a worktree starts without its own client download. Then open `http://localhost:3001` and log in as `tester@fosscord.test` or `friend@fosscord.test`. The seed script writes their passwords to `scripts/dev/.test-account`.

Runtime `.env` files and named variants such as `.env.local` and `.env.production` are ignored. Commit `.env.example` with placeholder values. Generated test accounts, recovery keys and client cache builds stay ignored, with regression coverage for those paths.

To open the admin dashboard as the seeded user, copy its numeric account ID from the client and give it the operator right. Run from the configured checkout; the command preserves its other rights:

```sh
bun scripts/ops/operator.mjs grant <account-id>
```

### Scripts

| Command                                              | What it does                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run build:src`                                  | Deletes `dist`, compiles `src` into it with `tsc` and draws the default avatars.                                                                                                                                                     |
| `bun run build`                                      | `build:src`, then regenerates `assets/schemas.json` and `assets/openapi.json`.                                                                                                                              |
| `bun run build:equicord`                              | Rebuilds `assets/vencord` after a change to `client/plugins`, `client/equicord-patches` or `client/vencord.json`.                                                                                            |
| `bun run build:e2ee`                                 | Bundles `client/e2ee` into `assets/public/e2ee`.                                                                                                                                                            |
| `bun run lint`, `bun run format` | Lints with Biome, or rewrites files in Biome's format. |
| `bun run test` | Runs the unit tests in `scripts/tests`, `scripts/dev` and `dist`. Build first, because the tests load the compiled code from `dist`. |
| `PORT=3001 scripts/dev/restart.sh`                   | Stops whatever listens on the port, starts the built server in the background and waits for `/api/ping`. `SERVER_LOG` sets the log file.                                                                    |
| `DB_NAME=fosscord PORT=3001 scripts/dev/reset-db.sh` | Stops the server and recreates the database. Start the server again to run the migrations.                                                                                                                  |
| `PORT=3001 bun scripts/dev/seed.mjs`                | Registers the test accounts, a DM and a server with a few messages.                                                                                                                                         |
| `PORT=3001 bun scripts/dev/parity-probe.mjs`        | Runs the parity checks against the API. A word after it runs only the checks whose name contains it, but many checks reuse what earlier ones created, so a filtered run can fail where the full run passes. |
| `PORT=3001 bun scripts/dev/e2ee-test.mjs`           | Drives several browser profiles through encrypted DMs, key backup, recovery codes and device approval. Takes about five minutes.                                                                            |
| `PORT=3001 bun scripts/dev/voice-probe.mjs`         | Joins two browsers to a voice channel and prints the audio each side sent and received. `--browser <path>` picks the browser.                                                                               |
| `PORT=3001 bun scripts/dev/probe.mjs <path>`        | Opens a client page as the test user and prints its text, console errors and failed requests. `--shot <file>` saves a screenshot and `--as friend` switches account.                                        |
| `PORT=3001 bun run check:client`                     | Builds Equicord's reporter and checks that every patch still finds its target in the cached client. The first run checks out Equicord into `.vencord`, about 300 MB.                                          |

The browser scripts load `playwright-core` from `~/.cache/fosscord-tools`. Install it there once:

```sh
mkdir -p ~/.cache/fosscord-tools && bun add --cwd ~/.cache/fosscord-tools playwright-core
```

`e2ee-test.mjs` and `check:client` use Google Chrome unless `CHROME_PATH` names another Chromium build. Recent Chrome releases on macOS quit headless sessions after about 30 seconds, and Brave works:

```sh
CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" PORT=3001 bun scripts/dev/e2ee-test.mjs
```

`scripts/dev` also has load and scale tests (`scale-*.mjs`, `seed-scale.mjs`, `seed-large.mjs`, `gateway-bench.mjs`, `perf.mjs`), a test bot and an OAuth2 example app.

## Deploying

[docs/self-hosting/native.md](docs/self-hosting/native.md) covers Linux hosting without Docker under a dedicated `meowcord` service account. Build as a separate normal user, install root-owned runtime files and keep writable state outside the checkout. Its systemd unit and maintenance commands are separate from the development fixtures and Compose updater.

[docs/self-hosting/deploy.md](docs/self-hosting/deploy.md) covers production. `docker-compose.yml` runs PostgreSQL, the server, the SFU and Caddy for TLS on one Linux host, and a one-shot service downloads the web client into a volume on the first start. The same guide covers updating, backups, the phone layout and running behind your own proxy.

Readiness verification runs with `READINESS_TEST_DATABASE=postgres://localhost/postgres bun test scripts/tests/readiness.test.cjs`. It performs only `SELECT 1` and interrupts its own TCP proxy to verify HTTP 200, 503 and recovery. It does not stop PostgreSQL or modify database rows.

`bun test scripts/tests/cap-widget-loader.test.cjs` checks empty SDK responses, stalled requests and retry admission without consuming verification proofs.

## Configuration

`CONFIG_PATH` in `.env` points the server at a JSON file. The server fills in every missing key with its default and writes the file back, so you only need to set what you change. With `CONFIG_PATH` unset the configuration lives in the database. The admin dashboard edits the same values. On startup, the defaults revision migrates the old `Fosscord` values in `client.instanceName` and `general.instanceName` to `Meowcord` once. Custom names stay unchanged. After that revision is stored, an operator can explicitly choose either name. These keys are specific to this project:

| Key                              | What it controls                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.instanceName`            | The name that replaces Discord in every string, the page title and the wordmark. `Meowcord` by default.                                                                                                                                                                                                                                                                                                        |
| `client.icon`, `client.logo`     | Square icon and wordmark, as a URL or a path relative to the repository root. The icon falls back to `general.image`, then `assets/icon.png`.                                                                                                                                                                                                                                                                  |
| `client.helpUrl`                 | Where help links go. Without it the help button is hidden.                                                                                                                                                                                                                                                                                                                                                     |
| `client.experiments`             | Map from client experiment name to the variant to assign.                                                                                                                                                                                                                                                                                                                                                      |
| `client.activityApplicationHost` | Host activities load from, see [docs/features/activities.md](docs/features/activities.md).                                                                                                                                                                                                                                                                                                                                       |
| `security.captcha`               | Cap core runs inside the server by default. For a Cap Standalone server, set `capMode: "standalone"`, `instance` to its URL and `sitekey` and `secret` to its keys. The server verifies at `<instance>/<sitekey>/siteverify`. Registration asks for a captcha, and with `enabled: true`, `login.requireCaptcha` and `passwordReset.requireCaptcha` add it to login and password reset. Cap is the only supported captcha. |
| `limits.rate`                    | Rate limits, on by default. `ip`, `global`, `error` and `identify` are instance-wide, and `routes` has a bucket per route group, each with a `count`, a `window` in seconds and an optional separate `GET` or `bot` count. Buckets are stored in Postgres.                                                                                                                                                     |
| `limits.e2ee`                    | Envelope size and device count caps, the pending device lifetime, and hourly limits for device registrations, device updates and key queries.                                                                                                                                                                                                                                                                  |
| `security.webPush`               | Web Push on or off, and the VAPID keys, which the server generates on first start.                                                                                                                                                                                                                                                                                                                             |
| `guild.safety`                   | Harmful link domains and the thresholds for join, DM and mention raid detection.                                                                                                                                                                                                                                                                                                                               |
| `integrations.gifs.klipy`        | The Klipy API key behind the GIF picker.                                                                                                                                                                                                                                                                                                                                                                       |

[docs/development/client-patches.md](docs/development/client-patches.md) has more on the branding keys and [docs/self-hosting/deploy.md](docs/self-hosting/deploy.md) on the environment variables.

## The Discord client

This repository holds no Discord code. `bun run generate:client` downloads the web client from discord.com to `assets/cache` on your own machine, and the Docker setup downloads it into a volume on the first start. `assets/cache`, `assets/cache_compressed` and `assets/vencord` are listed in `.gitignore` and `.dockerignore`. Discord owns that code, so don't commit it, publish it or put it in an image. Our changes live in this repository as Equicord plugins, a few string rewrites in `scripts/client.js` and the scripts in `assets/client_patches`, and they are applied to each local copy.

## Architecture

| Part              | Where                                        | What it does                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API               | `src/api`                                    | The REST API under `/api/v9`, plus the admin, status, developer portal and legal pages.                                                                                                                               |
| Gateway           | `src/gateway`                                | The websocket that sends events to clients.                                                                                                                                                                           |
| CDN               | `src/cdn`                                    | Attachments, avatars, icons, emojis and stickers.                                                                                                                                                                     |
| Voice gateway     | `src/webrtc`                                 | Discord's voice websocket protocol, including DAVE. It sends media setup to the SFU over a unix socket.                                                                                                               |
| SFU               | `extra/pion-sfu`                             | A Go selective forwarding unit, vendored from spacebarchat/pion-webrtc. It carries voice, video and Go Live on one UDP port. The server starts it when `PION_SFU_BIN` is set.                                         |
| Bundle            | `src/bundle`                                 | Runs all of the above in one process on one port, with the voice gateway under `/voice` unless `WRTC_WS_PORT` gives it its own port. It can also serve HTTPS and HTTP/2 itself.                                       |
| Web client server | `src/bundle/TestClient.ts`                   | Serves the cached client with precompressed files, sets `GLOBAL_ENV` to this instance, injects Equicord and the client patch scripts, and swaps Discord's images for the instance's.                                   |
| Equicord layer     | `client/plugins`, `client/equicord-patches`   | Equicord is built from a pinned commit with our source patches and plugins. The plugins strip upsells and tracking, apply the branding, and fix the parts of the client that assume discord.com.                       |
| E2EE client       | `client/e2ee`, `client/plugins/fosscordE2ee` | The encryption code, bundled with `Bun.build` and loaded by `assets/client_patches/10-e2ee-loader.js`. It hooks the client's message pipeline, and the plugin adds the lock button, safety numbers and the settings page. |
| Shared code       | `src/util`, `src/database`, `src/schemas`    | Config, entities, migrations and the request and response schemas the API validates against.                                                                                                                          |
## Branches

Branch off `main` and keep one topic per branch. To work on several things at once, give each one its own git worktree, port and database:

```sh
git worktree add ../fosscord-voice -b voice-reconnect
cd ../fosscord-voice
scripts/dev/worktree-setup.sh 3240 fosscord_voice
```

The setup script runs `bun install` in the worktree and links `assets/cache`, `assets/cache_compressed` and `assets/vencord` from the main checkout, so a worktree needs no client download. Run `bun run build:equicord` if you change the plugins, after removing the `assets/vencord` link so the build doesn't write into the main checkout. When the branch is done, stop its server, drop its database with `dropdb fosscord_voice` and remove the worktree.

## Commits

Commit as you go, in small steps. The subject line is a lowercase [conventional commit](https://www.conventionalcommits.org), in the imperative, with an optional scope and no trailing period. There is no body.

```
fix(e2ee): keep the nonce on nonce-bound encrypted messages and clear stale client tokens in the test
feat(e2ee): store a sealed contact verification list with the key backup
perf(bans): batch bulk bans and paginate the ban list with one joined query
docs(parity): mark member applications and reporting as working, probe join requests
```

The types in use are `feat`, `fix`, `perf`, `docs`, `test`, `chore`, `build` and `refactor`.

`bun install` points git at `.githooks`. The pre-commit hook runs `biome check` on the staged files, which fails on lint errors and on files Biome would format differently, then runs `bun run build:src` when anything in `src` is staged and `tsc -p client/e2ee` when anything in `client/e2ee` is, so a commit that doesn't compile is refused. When a file in `src/schemas` changes, it also regenerates `assets/schemas.json` and stages it. It leaves `assets/openapi.json` alone, because branches that run in parallel would all conflict on it. Regenerate it on `main` after merging with `bun run build` and a `chore: regenerate schemas and openapi after merges` commit.

## Code style

- Biome lints and formats with `biome.json`, which sets 4-space indents, double quotes and a 180 character line width. `bun run format` rewrites files, `bun run lint` lints them.
- Every new source file starts with the AGPL header. Copy it from any file in `src`.
- No code comments. Name things so the code reads without them.
- Migrations go in `src/database/migration/postgres`. Each one has to be idempotent (`IF NOT EXISTS`, `IF EXISTS`, or a check before the change) and have a timestamp later than every existing migration, made unique with a random suffix, such as `1791514025449`. A fresh database runs the migrations in timestamp order, so don't touch a table that a migration with a later timestamp creates. Test a new migration on a fresh database with `worktree-setup.sh`, which creates a new database and refuses existing ones.
- Client changes go into an Equicord plugin in `client/plugins` whenever possible. [docs/development/client-patches.md](docs/development/client-patches.md) has the rules for patches that survive Discord updates.
- After a change to `client/e2ee`, run `bun run build:e2ee` and commit `assets/public/e2ee` with it. `scripts/build-e2ee.js` bundles it with `Bun.build`.
- Never commit `assets/cache`, `assets/cache_compressed`, `assets/vencord` or `.vencord`. They hold Discord's code or builds made from it.
- When a feature's status changes, update its row in `docs/development/parity.md`. Docs use plain sentences and say what happens, with numbers where there are numbers.

## Before you push

Build, lint and run the unit tests:

```sh
bun run build:src
bun run lint
bun run test
```

Unit tests should pass without failures. Tests that need a database or the cached client skip themselves until `DATABASE_TEST_ADMIN_URL`, their own test database variable or `assets/cache` is there. CI runs the same three commands, plus `bun run typecheck`, `bun run release:pack` and the SFU's `go test`.

Restart your dev server on the new build and run the parity probe against it. It should end with no failures:

```sh
PORT=3001 SERVER_LOG=$PWD/server.log scripts/dev/restart.sh
PORT=3001 bun scripts/dev/parity-probe.mjs
```

Rate limits persist in the database. Don't clear global rate-limit rows to make a probe pass. Use disposable test accounts, honor `Retry-After`, and let each fixture remove only the records it created. Keep mutation probes on a database you created for the test.

Run the end-to-end encryption test when you change messages, channels, sessions, the gateway or anything under `client/e2ee`, `client/plugins/fosscordE2ee` or the `e2ee` routes. It takes several minutes and needs `E2EE_TEST_DATABASE_NAME` set to the database of the instance it runs against:

```sh
CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" PORT=3001 E2EE_TEST_DATABASE_NAME=<db> bun scripts/dev/e2ee-test.mjs
```

Run the client check when you change `client/plugins`, `client/equicord-patches` or `client/vencord.json`, and after downloading a new Discord build. It exits with code 1 when one of our patches, or an upstream plugin we turn on by default, no longer matches the client:

```sh
CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" PORT=3001 bun run check:client
```

`bun run typecheck:equicord` checks the injected plugins against the pinned Equicord compiler without building client assets, and `bun scripts/client.js --check` checks the cached client's asset dependencies without downloading anything.

For voice and video changes, run `PORT=3001 bun scripts/dev/voice-probe.mjs --browser "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"` and check that both users report audio packets in each direction. It needs the SFU, which `worktree-setup.sh` builds when Go is installed.

### Focused checks

The unit tests in `scripts/tests` cover these areas without a browser instance. The smoke scripts in `scripts/dev` drive the real client against an isolated, seeded instance. Most of them need `TEST_ACCOUNT_PATH` pointing at the seeded account file, and the admin ones need operator rights on that account. Run each smoke in Chromium first, then again with `BROWSER=webkit`, one engine at a time, because they share the account's write limits.

| After changing                          | Unit tests                                                                                                                                          | Smoke scripts                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog focus                            | `auth-modal-focus.test.cjs`                                                                                                                         | `auth-modal-smoke.mjs`, `admin-drawer-focus-smoke.mjs`                                                                                                           |
| Dialog scrolling                        | `portal-dialog-scroll.test.cjs`, `client-dialog-scroll.test.cjs`                                                                                    | `portal-dialog-scroll-smoke.mjs`, `encryption-dialog-scroll-smoke.mjs`                                                                                           |
| Admin saves and dirty forms             | `admin-pending-save.test.cjs`                                                                                                                       | `admin-pending-save-smoke.mjs`                                                                                                                                   |
| Admin sign-in and session expiry        | `admin-session-expiry-ui.test.cjs`                                                                                                                  | `admin-session-expiry-smoke.mjs`                                                                                                                                 |
| Admin list refresh                      | `admin-list-refresh.test.cjs`                                                                                                                       | `admin-list-refresh-smoke.mjs`                                                                                                                                   |
| Developer portal dialogs and routing    | `portal-dialog-lifecycle.test.cjs`, `portal-route-race.test.cjs`, `portal-save-lifecycle.test.cjs`                                                  | `portal-dialog-lifecycle-smoke.mjs`                                                                                                                              |
| Portal bots, activities and widgets     | `portal-bot-token-lifecycle.test.cjs`, `portal-activity-lifecycle.test.cjs`, `portal-widget-deletion.test.cjs`                                      | `portal-bot-reset-smoke.mjs`, `portal-bot-profile-smoke.mjs`, `portal-value-drafts-smoke.mjs`, `portal-widget-drafts-smoke.mjs`, `portal-widget-image-smoke.mjs` |
| Portal application settings             | `application-metadata.test.cjs`, `application-oauth-config.test.cjs`, `portal-information-drafts.test.cjs`                                          | `portal-information-drafts-smoke.mjs`, `application-oauth-config-smoke.mjs`, `application-metadata-smoke.mjs`                                                    |
| Slowmode                                | `message-slowmode.test.cjs`, with `DATABASE_TEST_ADMIN_URL` set; it creates and drops its own database                                             | `slowmode-client-smoke.mjs`                                                                                                                                      |
| Client workers and Equicord toasts      | `equicord-toast-compatibility.test.cjs`                                                                                                             | `client-worker-smoke.mjs`, `equicord-toast-smoke.mjs`                                                                                                            |

`application-metadata-smoke.mjs` also needs `APPLICATION_METADATA_TEST_DATABASE` set to a freshly created database, because it adds temporary constraints to force write failures.

[docs/development/dialog-dismissal.md](docs/development/dialog-dismissal.md) describes how the owned dialogs and the developer portal behave, which these checks verify.

The project's task queue is [docs/development/work-backlog.md](docs/development/work-backlog.md). Each task has a stable ID, priority and acceptance target. Remove a task once its behavior is verified and shipped, and update the doc that describes the feature.
