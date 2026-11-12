# Meowcord work backlog

This is the task queue for admin, app, compatibility, reliability and performance work. Each entry is a planned investigation or an acceptance target, not a claim that a confirmed bug exists. Source pointers say where to start. Remove an entry once its behavior is verified and shipped, and update the feature doc that describes it.

P0 means a reported crash, trapped flow or broken core interaction. P1 means active completeness, reliability or measured performance work. P2 means polish and consolidation. Task IDs stay the same when priorities change.

PostgreSQL and SQLite backend selection is implemented. Database schema changes must include equivalent migrations for both backends, with fresh-database verification.

## Modal layering and dismissal (P0)

Start with `client/plugins; assets/public/admin`.

- [ ] **MOD-001** Reproduce banner preview beneath an expanded profile.
- [ ] **MOD-002** Fix the banner preview and expanded-profile stacking order.
- [ ] **MOD-004** Inventory outside-click behavior for every custom modal and popover. Owned families are recorded in [dialog-dismissal.md](dialog-dismissal.md); upstream profile/banner and other cached-client overlays still need rendered inspection.
- [ ] **MOD-009** Confirm unsaved edits before outside-click dismissal.
- [ ] **MOD-010** Keep required signup and locked-browser dialogs required.
- [ ] **MOD-011** Verify overlays in desktop and mobile layouts.
- [ ] **MOD-012** Remove stale backdrops after route changes or errors. Admin sign-in and portal route changes are handled; other dialog families still need lifecycle coverage.
- [ ] **MOD-013** Use native portal layers instead of arbitrary competing z-index values.

## Pride flags and profile badges (P1)

Account-age and activity progression now have native directory menus and bundled tier artwork, described in [badges.md](../features/badges.md).

Start with `src/api/util/utility/prideBadges.ts; client/plugins/fosscordPride`.

- [ ] **FLAG-007** Verify badges render in compact and expanded profiles.
- [ ] **FLAG-008** Check selection search, keyboard interaction and empty results.
- [ ] **FLAG-012** Measure profile badge rendering with a large selection.
- [ ] **QA-016** Check that default and profile badge artwork is available without runtime upstream requests. Sample each configured and default badge on the current deployment, keep custom images, and don't broadly enable upstream fetching.

## Admin navigation and lists (P1)

Start with `assets/public/admin/admin.js; src/api/routes/admin`.

- [x] **ADM-009** Add bounded or cursor pagination for very large lists. Users and Servers page by keyset cursor in every sort, server members, bans and invites only page by cursor, and the reports, IP, IP ban and instance invite lists refuse offsets past 10,000.
- [x] **ADM-010** Check keyboard navigation, labels and mobile table overflow. Every page at 390px wide scrolls tables inside their card and never the page, rows open with Enter or Space, the unlabeled status page and feature flag inputs have names, and headings and table headers are no longer all caps.
- [x] **ADM-012** Inventory every drawer field against server validation. The server tag, language, owner ID, status component, incident update and badge link fields stop at the server's limits, and status component, shop pack and shop item positions refuse values outside a 32-bit integer with HTTP 400 instead of reaching the database.
- [x] **ADM-013** Provide useful empty states with one relevant action. Each empty list says what belongs there and offers one button, such as clearing the search and filter or creating the first item.
- [x] **ADM-014** Verify permission-restricted navigation and direct links. A direct link to a page your rights don't open names the right it needs and links to the Overview, instead of showing the Overview under the old address.

## User administration (P1)

Start with `docs/development/admin-api-coverage.md; src/api/routes/admin/users`.

- [ ] **USR-001** Inventory remaining per-user API coverage with exact evidence.
- [x] **USR-002** Make preference writes and audit records transactional. The admin route and `/users/@me/settings` write the legacy settings, the settings proto, session statuses and the audit record in one transaction, and send gateway events after it commits.
- [ ] **USR-003** Add server-specific nickname and profile administration.
- [ ] **USR-004** Add explicit per-server member-role controls.
- [ ] **USR-005** Add validated per-server avatar, banner and theme controls.
- [ ] **USR-006** Add scoped membership and timeout administration.
- [ ] **USR-007** Add per-user saved-avatar management.
- [ ] **USR-008** Add connected-account metadata and disconnect controls.
- [ ] **USR-009** Add notification and consent preference administration.
- [ ] **USR-010** Add saved-message metadata administration.
- [ ] **USR-011** Add scheduled-message administration without exposing encrypted contents.
- [ ] **USR-012** Add per-user entitlement and collectible ownership adjustments.
- [ ] **USR-013** Record inventory and currency changes with explicit transactions.
- [x] **USR-014** Let people pick an avatar corner radius from a circle to a square that everyone sees. `users.avatar_corner_radius` holds 0 to 50 or `null`, every public user object and federation profile carries it, and the `FosscordAvatarShape` plugin draws every avatar, its status cutout and the profile banner hole with it. See [avatar-shape.md](../features/avatar-shape.md).

## Shop and packs (P1)

Start with `src/api/routes/admin/store; assets/public/admin`.

- [ ] **SHOP-004** Add clear preview and validation for artwork uploads. Refused frame replacements already keep the old layers; preview work remains.
- [ ] **SHOP-006** Keep Discord decoration assets free in the local shop.
- [ ] **SHOP-007** Add server-free sticker and emoji packs. Sticker packs are managed on the dashboard's Sticker packs page; emoji packs remain.
- [ ] **SHOP-008** Define ownership, visibility and sharing for server-free expression packs.
- [ ] **SHOP-009** Add import and export for local pack metadata.
- [ ] **SHOP-010** Check shop rendering with thousands of items. The Steam category has 2158 products. `/collectibles-categories` grew from about 3.2 MB to 5.1 MB and answers in 27 to 80 ms on a laptop, and the category page keeps every card in the DOM. Virtualizing the grid or paging the category remains.
- [ ] **SHOP-011** Bound item and pack administration responses.
- [ ] **SHOP-014** Verify profile frames, effects and nameplates across profile layouts.
- [x] **SHOP-015** Show profile effects and nameplates of people on other instances. `collectibles` and `profile_effect` skip id translation like `avatar_decoration_data`, and `localizeDecorations` maps their SKUs the same way. A SKU stays when this shop has the item and otherwise maps to a local id whose art the CDN fetches from the sender for every slot. `GET /collectibles-products/<local id>` asks the sender's new `GET /federation/v2/collectibles/<canonical>` for an unknown effect and rebuilds it with art on this CDN. Shadows store `collectibles`, so nameplates also show for remote members of local servers. Remote profile frames still show only when this shop has them.
- [x] **SHOP-016** Let people equip a server avatar decoration in a server on another instance. The host maps the home's SKU to a local id as before, and the member route asks the home's `GET /federation/v2/collectibles/<canonical>`, which now also answers avatar decorations, for the asset. It keeps the home's SKU when its own shop has the same art and otherwise stores the local id, whose art the CDN fetches from the home. Outgoing payloads write SKUs mapped from another instance as `@<sku>@<instance>`, so the home gets its own SKU back and a third instance maps it to that instance. Only the shadow of the item's home can wear a mapped SKU.
- [x] **SHOP-017** Add the Steam Points Shop avatar frames as a built-in Shop category. `scripts/steam-frames.mjs` writes `assets/steam-frames.json` from Steam's public API, every instance gives each frame the same SKU and asset, the CDN fetches the art from Steam's CDN through `PUBLIC_FETCH_PROXY` under `externalRequests.steamAssetFallback`, and FosscordFrames scales the art by 1.0145 to match Steam's 224 to 184 pixel ratio. The category page renders all 2162 cards, 2158 after the exclusions, at once, which the first measurements put at 5.8 seconds from navigation to the first card on a cold load, including the client's start, and 2.4 seconds to scroll 48000 pixels. See [steam-frames.md](../features/steam-frames.md).
- [ ] **STICKER-003** Support independent sticker and emoji packs that don't require a guild. Operators make guild-free sticker packs in the dashboard; emoji packs remain.

## Server administration (P1)

Start with `docs/development/admin-api-coverage.md; src/api/routes/admin/guilds`.

- [x] **GUILD-001** Add member search and paginated member administration. The server drawer's Members section pages 50 members at a time by user ID cursor, searches IDs, usernames, display names and nicknames, and edits nicknames, roles and timeouts or removes members, gated by `MANAGE_GUILDS` and staff hierarchy.
- [ ] **GUILD-002** Expose channel permission-overwrite management.
- [ ] **GUILD-003** Expose complete thread and forum settings.
- [x] **GUILD-004** Expose invite lifecycle controls. The server drawer's Invites section creates invites with an expiry, a use limit and temporary membership, pages them newest first by cursor and revokes them, with server audit entries.
- [x] **GUILD-005** Expose ban, unban and timeout controls with audit entries. The member page in the server drawer times out, removes and bans, and the Bans section pages bans by cursor and lifts them. Each action writes a staff audit entry and a server audit log entry with the reason.
- [x] **GUILD-006** Expose emoji and sticker management. The server drawer's Emoji and stickers section renames, edits and deletes custom emoji and stickers with server audit entries and gateway updates. Uploads stay in the client.
- [x] **GUILD-007** Expose soundboard management. The server drawer lists soundboard sounds, plays them, edits their name, volume and emoji and deletes them, with server audit entries and gateway events.
- [ ] **GUILD-008** Expose scheduled-event management.
- [ ] **GUILD-009** Expose onboarding configuration and prompts.
- [ ] **GUILD-010** Expose member applications and join-request review.
- [ ] **GUILD-011** Expose integrations and webhook settings with scoped rights.
- [ ] **GUILD-012** Verify ownership transfer and operator-target safeguards.
- [ ] **GUILD-013** Check server features against client-supported values.
- [ ] **GUILD-014** Verify mutations reach active clients through gateway events.

## Performance and bounded work (P1)

Start with `docs/features/admin.md; src/api/util/handlers`.

- [x] **PERF-001** Measure current slow routes with realistic isolated fixtures. `scripts/dev/seed-perf.mjs` builds a guild with 3,001 members, 60 roles, 41 channels with permission overwrites, 30,000 messages in one channel and 20,000 messages by one author. `scripts/dev/hot-paths.mjs` times history, message send, typing, ack, channel and member reads, identify, lazy member lists and presence, and reports the median, p95, server CPU per operation and query count. On an Apple M3 with 8 cores and 24 GB at revision `9f0b55fba`, the slowest paths were a lazy member list request at 113 ms and a 1,000 member page at 49 ms. After the changes at `c22cd5965` they take 20 ms and 36 ms.
- [x] **PERF-002** Record baseline query counts before each optimization. `hot-paths.mjs --queries` counts queries per operation from the server log when `DB_LOGGING` is on. Before the optimizations a history page took 14 to 23 queries, a send 19 to 29, typing 8, ack 11, identify 46 and a lazy member list request 11. Now history takes 16 or 17, typing 7, ack 7 and a lazy member list request 7.
- [x] **PERF-005** Bound interaction HTTP execution with an end-to-end deadline. HTTP delivery shares one 3 second window with the interaction failure timer. The key lookup, the outbound slot, the signed request and the response read all run inside it, the signed request gets only the time left, and a response that arrives after the window is dropped instead of answering an interaction the client already marked as failed. Before, a slow key lookup came on top of a fresh 3 second request timeout.
- [x] **PERF-007** Bound gateway outbound and replay byte budgets. Each socket already capped its replay at 250 events or 8 MiB, its resume queue at 5,000 events or 16 MiB and its send buffer at 32 MiB, but nothing capped the sum, so one account with many connections could hold 24 MiB per connection. Replay and resume bytes now count against `limits.gateway.retainedDispatchBytesPerUser`, 64 MiB, and `limits.gateway.retainedDispatchBytes`, 1 GiB. Buffers return their bytes when a session closes, resumes or expires, and a resume from before an evicted event gets an invalid session instead of a silent gap.
- [x] **PERF-008** Bound channel history and search relation loading. `Message.loadRelations` loads authors, attachments and every mention junction table in one round, then the mentioned users, roles, channels and stickers in a second, in place of TypeORM's joined pagination query. A 50 message page with replies went from a 22.6 ms median to 6.0 ms when measured in process, history takes 16 or 17 queries for any page shape, and a search page went from about 73 ms to 51 ms.
- [x] **PERF-009** Measure short-term search and expensive exact counts. A search counts at most 10,000 hits with `COUNT(*)` over a subquery limited to 10,000 rows, and runs that count beside the page query instead of before it. In a channel of 30,000 messages the term "a" matched every message and its exact count took a median of 291.5 ms, while the capped count takes 63.5 ms. "lorem" went from 54.5 ms to 32.4 ms, and a term with no hits stayed near 1.5 ms. A term that matches nothing still scans the channel, and the admin list counts are still exact.
- [x] **PERF-010** Bound encryption plaintext caches and key lookup batches. The browser's decrypted payloads, content keys, stored backup keys and federation id maps are least recently used caches of 5,000 entries, the key directory holds 2,000 users, search copies hold 50 channels of 2,000 messages, and the service worker keeps 2,000 file entries and 64 video posters. All of them grew for the whole session before. Key lookups started in the same tick share one request, split at 100 users. Before, a lookup of more than 100 users went out as one request that the server refused with 400, and decrypting a page from 30 senders sent 30 requests against the 60 per minute key lookup limit.
- [x] **PERF-011** Add CDN cache quotas and eviction measurements. Triggers on `storage_runtime_objects` keep the bytes and object count per namespace, per budget principal and for the cache category in `storage_runtime_usage`, and quota checks and eviction read those rows. Before, every reserved write ran three `SUM` and `COUNT` scans over every stored object. With 1,000,000 objects those scans took 69 to 178 ms each on an idle machine and up to 1,279 ms under load, and a counter read takes 0.3 ms. The triggers add 2.1 ms to an insert and 1.0 ms to a delete, and the migration backfills 1,000,000 objects in 2.7 seconds.
- [x] **PERF-012** Bound ffmpeg work queues and API-to-CDN upload deadlines. Preview requests now reserve one of the 4 ffmpeg slots before they read the attachment or download up to 50 MiB through the media proxy, and get 503 when all 4 are taken. Before, the slot check ran after the download, so 32 proxy requests could each pull 50 MiB to get a 415. Message and interaction uploads from the API to the CDN share one deadline per request, `cdn.uploadDeadlineSeconds`, 60 by default, on top of the 30 seconds per file, where 15 files could take 450 seconds before.
- [x] **PERF-013** Avoid global voice locks around network work. Relaying a voice state to the instance that hosts a call held the per-user `voice:<user>` lock for the whole signed request, up to its 20 second timeout. Inbox events for that user waited on it, and because the inbox applies a server's events under that server's `guild:<id>` lock, so did every later event of the server, and a `VOICE_SERVER_UPDATE` waited before reaching the recipients listed after that user. Relays of one user now keep their order on a separate `voice-relay:<user>` queue and take the voice lock only to store the answer. When a host event for the user is applied while the request is out, the answer is dropped, since the host sends that event after the change the request made. A refused leave still clears the local state. With the host answering after 400 ms, the user's own inbox event went from 386 ms to 0.6 ms, the next event of the same server from 386 ms to 0.7 ms and a server update for 10 users from 386 ms to 0.7 ms. On the voice gateway each socket handles its commands one at a time, and that queue waited on network work for other members: publishing subscribed each member with one SFU round trip after another, selecting a protocol sent 5 messages per member waiting for each write, and leaving sent `CLIENT_DISCONNECT` to one member at a time, as did DAVE proposal revokes. These now run at the same time, and messages to any one socket keep their order. With a fake SFU answering after 5 ms in a room of 25, publishing audio went from 165.5 ms to 7.1 ms. With 5 ms per socket write, joining went from 765.9 ms to 19.0 ms and leaving from 147.8 ms to 6.3 ms. Against the real SFU on an idle machine, publishing audio took a median of 1.5 ms before and 0.6 ms after in a room of 25, and 3.1 ms and 1.8 ms in a room of 100. `scripts/tests/voice-network-locks.test.cjs` measures these cases and checks the ordering. The SFU still writes IPC replies under one lock, because frames on the one socket must not interleave, and each write has a 5 second deadline.
- [x] **PERF-014** Index SFU subscribers instead of repeatedly snapshotting all peers. Every forwarded RTP packet copied every peer on the SFU into a new slice and locked each peer to read its subscriptions, and the bandwidth loop did the same for each video publisher once a second. The SFU now keeps a copy-on-write list of subscribers per track, changed on subscribe, unsubscribe and leave, and a reverse index per subscriber so a leave removes its subscriptions without scanning other peers. A subscribe to or from a peer that already left is refused, where it used to leave a stale entry. On an Apple M3 with 8 cores and 24 GB at load 2 to 3, against `2a6e2e74e`, `go test -bench` measured a lookup with 5 subscribers among 10, 100 and 1,000 peers at 173 ns, 1,230 ns and 15,400 ns with one allocation of up to 8,192 bytes, and now 7.4 ns at every size with no allocation. With 8 goroutines forwarding in full-mesh rooms, a lookup went from 231 ns to 95 ns in a room of 10, 415 ns to 93 ns in a room of 25, 1,490 ns to 95 ns in a room of 100 and 12,400 ns to 95 ns with 40 rooms of 25. At 50 audio packets a second from 1,000 speakers that is 0.62 CPU seconds per second before and 4.8 ms after. A bandwidth tick with 5 video publishers per room of 25 went from 5.5 µs to 4.5 µs for one room and from 2.7 ms to 185 µs for 40 rooms. `subscribers_test.go` covers the index, including concurrent subscribe and unsubscribe under `go test -race`.
- [ ] **PERF-015** Measure admin search and drawer latency under concurrency.
- [ ] **PERF-016** Keep benchmark claims tied to fixture size, host and revision.
- [ ] **PERF-017** Integrate bounded compression for public E2EE, admin and portal files. Remaining: a coordinated demo build and measurement of live response headers and bodies.
- [ ] **PERF-020** Keep gateway resume state usable across processes instead of process-local.
- [ ] **PERF-021** Support lazy member lists for servers above 5,000 members.
- [x] **PERF-022** Bound identify and listener work for users in many servers. `seed-perf.mjs` adds 100 servers with 30 channels, 15 roles and 50 emojis each, 5,000 threads and 50,000 audit log entries. Identify loads only the threads the user joined, 1,000 ids per query, where it loaded all 5,000 and filtered them in memory. The gateway listener loads channels in a query of their own, because joining members, roles and channels returned 33,268 rows for the test account. A `CHANNEL_CREATE` subscribes open sockets from the event instead of reloading the server. Identify server CPU went from 152 ms to 116 ms for the test account and from 243 ms to 199 ms for an account in 102 servers. Creating a channel went from 129 ms of server CPU and a 110.7 ms p95 to 24 ms and 19.7 ms. The READY payload for 102 servers is 3,974,057 bytes, 3,863,997 of them in `guilds`, and keeps Discord's shape.
- [x] **PERF-023** Index the audit log and bound admin server lists. Audit log pages use an index on guild and id and another on guild, action type and id, and the page size is clamped to 1 to 100, where `limit=abc` returned 500. The first page of 50,000 entries read 1,240 buffers before and 5 after, and the filtered page reads 22. The admin server list sorts by the stored member count and counts members only for the servers on the page, in place of a correlated count for every server.
- [x] **PERF-024** Measure gateway fan-out with many connected sockets. `scripts/dev/gateway-fanout.mjs --sockets <n>` connects n perf users from the `seed-perf.mjs` guild, 40 identifies at a time, and reports identifies per second, READY latency, queries per identify, the busiest pool moment from `pg_stat_activity`, and server RSS growth per socket. It then times `MESSAGE_CREATE`, `TYPING_START`, `PRESENCE_UPDATE`, `GUILD_MEMBER_UPDATE`, `CHANNEL_CREATE` and `GUILD_ROLE_UPDATE` from the request until every socket has the event, and counts their queries in a `DB_LOGGING` server log, leaving out heartbeat writes. Each socket used to hold its own bus listener for every channel and thread it could see, 5,041 in the perf guild, which cost 2.9 to 5.4 MB of RSS per socket. Sockets in a guild now share one bus listener per channel, public thread events reach the sockets that can see the parent, and each socket keeps only its visible channels and private threads. A role update used to read the member and permissions of every socket with three queries each, and now reads them for the whole guild in one batch per event, so permission changes still apply on the next event. Dispatch data is serialized once per event instead of once per socket, and attachment URLs are signed on a per-socket copy instead of on the shared event. On an Apple M3 with 8 cores and 24 GB at load 3 to 11, interleaving the base `d9107baf6` and the change: with 300 sockets identify went from 35 to 133 per second, server CPU per identify from 38 to 11 ms, RSS per socket from 5.4 MB to 0.62 MB, and a role update from 931 queries and a 651 ms median to 30 queries and 45 ms. With 1,000 sockets identify went from 41 to 80 per second, RSS per socket from 4.4 MB to 0.53 MB, and a role update from 3,033 queries and 2,209 ms to 32 queries and 115 ms. With 2,000 sockets identify went from 34 to 103 per second, RSS from 6.3 GB to 1.2 GB, and a role update from 6,033 queries and 3,525 ms to 36 queries and 193 ms. Messages, typing, member updates and channel creates took the same queries before and after, 7 to 22, and their median delivery to the last socket stayed between 20 and 140 ms. The pool of 20 was never exhausted at low load, with at most 8 connections busy during identify. The `connection timeout` errors seen earlier happened at load 100 to 380, where PostgreSQL took more than 30 seconds to open a connection and identifies also hit the session timeout, closing with 4009, in both the base and the change. In both builds about 17 of the 50 sockets with a member list miss each presence update from the tester, and the cause is not known yet, so the presence numbers only cover the sockets that got it.

## Background jobs and reliability (P1)

Start with `docs/features/admin.md; src/util`.

- [x] **JOB-001** Make scheduled-message publication durably idempotent. The claim stores a message id in `scheduled_messages.message_id`, a retry after a crash reuses it, and a message that already exists counts as sent.
- [x] **JOB-002** Verify scheduler behavior across simultaneous workers. `scheduler-concurrency.postgres.cjs` runs each job in two Bun processes against one PostgreSQL database. It found duplicate scheduled event updates, double CDN deletes from the three file sweepers, a discovery index key collision, lost and duplicated federation outbox events and two data packages built for one request. Each is fixed with a lease in `job_leases`, a conditional update or an advisory lock, see [runtime-internals.md](runtime-internals.md#leases-across-processes). The delivery counters are atomic updates and an instance move is resumed under a `federation-move:<id>` lease.
- [ ] **JOB-007** Cancel replaced-track readers in the SFU.
- [ ] **JOB-008** Bound retry queues and backoff under dependency failure. The Unix, RabbitMQ and JSON worker queues and the image decoding paths have limits, described in [runtime-internals.md](runtime-internals.md) and [limits.md](../security/limits.md#images-the-server-decodes). The federation outbox now holds at most 10,000 events per instance across all processes, and every process waits out one shared backoff for an instance that is down. `serialized` in `federationMirrors.ts` holds at most 1,024 waiters per server and 10,000 servers, and the inbox answers 503 past that so the sender retries. Other codecs, nested and vendor metadata parsing, decoder overhead, filesystem open and stat stalls, duplicate waiters and the remaining dependency queues still need an audit.
- [x] **JOB-009** Make shutdown drain tasks without hanging indefinitely. Lifecycle work, timers, transports and workers drain on SIGTERM and SIGINT, and a 30-second watchdog forces exit, see [runtime-internals.md](runtime-internals.md#shutdown). An audit of 21 recurring timers found two without a stop hook, the discovery indexer and the scam list refresh. Both now clear their timers and wait for a run in progress, and discovery runs no longer overlap. The thread archiver pages 500 threads at a time and archives each one with a conditional update, so two workers emit one update per thread. The scheduled event sweeps take 100 events per batch and at most 10 batches per tick.
- [x] **JOB-010** Audit process-local interaction state for horizontal scaling.
- [x] **JOB-011** Document job ownership, deadlines and failure recovery. [runtime-internals.md](runtime-internals.md#background-jobs) lists each recurring job with its interval, the processes that run it, its batch size, what happens when it fails and how it stops.
- [x] **JOB-017** Order concurrent message sends consistently for last-message pointers and nonces. `Channel.advanceLastMessage` and `Member.advanceLastMessage` only move `last_message_id` forward, so a send that commits after a newer one leaves the pointer on the newer message. A send with a nonce takes an advisory lock on the channel, author and nonce inside its write transaction and returns the stored message when another send with that nonce already committed in the last 5 minutes. `message-slowmode.postgres.cjs` covers both with and without slowmode.

## Compatibility and app behavior (P1)

Start with `docs/development/parity.md; client/plugins; client/equicord-patches`.

- [ ] **APP-001** Run current native patch checks after plugin changes.
- [ ] **APP-002** Keep required native patches compatible with upstream build changes.
- [ ] **APP-005** Verify profile banner preview outside expanded profiles.
- [ ] **APP-006** Verify themes and contrast across every custom component.
- [ ] **APP-007** Check iPhone registration and desktop registration flows.
- [ ] **APP-009** Check reduced-motion and keyboard-only behavior.
- [ ] **APP-013** Provide the native UnifiedPush bridge, `globalThis.__meowcordUnifiedPush.register`, that the mobile bundle in `client/mobile` calls to register a `webpush` device, and answer `POST /messages-log/private-channels/get`. The host redirect and encrypted text DMs work in the emulator. See [android-client.md](android-client.md).
- [ ] **APP-010** Verify account and server customization updates without reload.
- [ ] **APP-011** Keep guild messaging behavior intact while private chats require encryption.
- [ ] **APP-014** Add E2EE UI to the Android bundle: the approval prompt with its code, safety numbers, an Encryption settings page and send errors in the composer. Encrypt attachments without a service worker. See [android-client.md](android-client.md#encrypted-dms).
- [ ] **APP-012** Audit safe clipboard and download behavior on mobile Safari.
- [ ] Serialize concurrent role hierarchy mutations and finish bot privileged intent approval and MESSAGE_CONTENT projection.
- [ ] **APP-024** Check H.264 negotiation compatibility in the SFU.
- [x] **APP-025** Answer `GET /users/@me/program-rewards`. It answers `{ "rewards": [] }` with a declared `ProgramRewardsResponse`, since rewards are a paid perk.

## GIFs and external dependencies (P1)

Start with `docs/self-hosting/external-services.md; client/plugins; src/api/routes/gifs`.

- [ ] **GIF-001** Verify Klipy search, categories and pagination with a configured key.
- [ ] **GIF-002** Verify Tenor fallback and provider selection.
- [ ] **GIF-003** Persist the Klipy key only in operator settings.
- [ ] **GIF-004** Keep credentials out of public settings and logs.
- [ ] **GIF-005** Show a useful empty state when the chosen provider is unavailable.
- [ ] **GIF-007** Audit all remaining runtime third-party requests. The server menu's admin videos, hard-coded `embed/avatars` URLs and the onboarding testimonial avatars now load from this instance. Left in the cached client: `cdn.discordapp.com/app-assets/1346069614634864772/store/`, `assets/server-subscription-tier-template`, `assets/22_211_SuperReactions_GTM_Hero_v09`, `assets/og_img_discord_home` and one guild member avatar, none of which a walk of the main screens loaded.
- [ ] **GIF-008** Keep optional external integrations disabled without explicit configuration.
- [ ] **GIF-009** Verify native media previews use local proxy policy where applicable.
- [ ] **GIF-010** Document unavoidable provider dependencies and offline alternatives.

## Encryption and recovery (P1)

Start with `docs/features/e2ee.md; client/e2ee`.

- [ ] **ENC-001** Verify existing account recovery state without resetting history.
- [ ] **ENC-002** Ensure trusted browsers publish recovery after successful key setup.
- [ ] **ENC-003** Verify password-only recovery after server restart.
- [ ] **ENC-004** Verify password changes keep the same message keys.
- [ ] **ENC-005** Verify failed recovery never sends a private message in plaintext.
- [ ] **ENC-006** Keep the default header neutral and remove per-message decorations.
- [ ] **ENC-007** Keep strict-browser behavior accurately described.
- [ ] **ENC-008** Measure and bound history backfill work.
- [ ] **ENC-009** Distinguish unavailable recovery service from permanently missing keys.
- [ ] **ENC-010** Add operator diagnostics that expose status but never secrets.
- [ ] **ENC-011** Verify recovery master persistence and failure on a missing master.
- [ ] **ENC-012** Audit key rotation, reset and recovery races.
- [ ] **ENC-013** Keep private-channel enforcement consistent for all senders.
- [ ] **ENC-014** Plan guild encryption separately with an explicit compatibility design.
- [ ] **ENC-015** Integrate the private-chat preparation fixes: a nonblocking attachment worker, a 15-second native HTTP deadline without hidden retries, an immediate trusted-browser Unlock action and coalesced member UI loading with stale-navigation suppression and failure backoff. Remaining: bundle build, a full E2EE run and browser checks of locked, unlocked and offline navigation.
- [ ] **ENC-018** Add encryption backup failure markers and define negative-cache behavior for key lookups.
- [ ] **ENC-022** Serve the keys of a group DM member who left to an instance whose only route to them was the group, when that instance never cached them. The member's home only answers instances that still share a conversation with them, the host of a group they left, or one whose user is still in that group on the home's mirror, and the home drops its mirror once its last local member leaves. See [e2ee.md](../features/e2ee.md#members-who-left-a-group).

## Components and accessibility (P2)

Start with `docs/development/native-ui.md; client/plugins/fosscordCore`.

- [ ] **UI-001** Inventory duplicated buttons, fields, dialogs and search controls.
- [ ] **UI-002** Reuse native Discord components where the interface supports them.
- [ ] **UI-003** Define shared semantic colors and spacing for custom surfaces.
- [ ] **UI-004** Define a consistent modal, popover and backdrop contract.
- [ ] **UI-005** Keep visible labels and associated validation messages.
- [ ] **UI-006** Make icon-only actions keyboard accessible and named.
- [ ] **UI-007** Verify touch targets and focus rings.
- [ ] **UI-008** Check long names, IDs and translated labels for overflow.
- [ ] **UI-009** Keep counters and timers from shifting layout.
- [ ] **UI-010** Provide copy that identifies the failed action and recovery step.
- [ ] **UI-011** Avoid decorative motion for frequent actions.
- [ ] **UI-012** Check nested radius alignment and compact profile badge artwork.

## Tests and benchmarking (P1)

Start with `scripts/dev; scripts/tests`.

- [ ] **QA-001** Keep all mutation probes on explicitly isolated databases.
- [ ] **QA-002** Create disposable test accounts instead of reusing demo users.
- [ ] **QA-003** Preserve recoverable fixture keys on interrupted encryption tests.
- [ ] **QA-004** Stop resetting global rate limits in test cleanup.
- [ ] **QA-005** Add an overlay smoke for click-outside, Escape and stacking.
- [ ] **QA-006** Add a Cap failure and retry browser smoke.
- [ ] **QA-007** Add a mobile signup smoke with captured console failures.
- [ ] **QA-008** Run route smoke after backend changes and demo restart.
- [ ] **QA-009** Run relevant PostgreSQL fixtures separately from skipped unit cases.
- [ ] **QA-010** Store query counts and latency distributions with source revisions.
- [ ] **QA-011** Build a medium-sized isolated load fixture before capacity claims.
- [ ] **QA-012** Measure sustained behavior and resource use, not only throughput.
- [ ] **QA-013** Verify failed tests restore only their own fixtures.
- [ ] **QA-014** Separate focused browser checks from full-suite success claims.

## Upstream and operations (P1)

Start with `CONTRIBUTING.MD; docs/self-hosting/native.md; docs/self-hosting/setup.md; scripts/client.js`.

- [ ] **OPS-001** Refresh upstream history and report whether new commits need integration.
- [ ] **OPS-002** Keep normal pushes directly to main within the user-authorized workflow.
- [ ] **OPS-003** Commit verified changes in small coherent batches.
- [ ] **OPS-005** Keep localhost demo source synchronized with committed main.
- [ ] **OPS-007** Document safe current commands for encryption fixtures.
- [ ] **OPS-008** Publish complete versioned client asset snapshots. The reviewed index for each pin is published as the `client-<buildNumber>` GitHub release and `scripts/client.js` downloads it, see [client-patches.md](client-patches.md#reviewed-client-releases). The assets still come from discord.com, so a build whose assets Discord deletes cannot be installed fresh.
- [ ] **OPS-009** Verify deployment health and service restart behavior. [native.md](../self-hosting/native.md) documents the dedicated service account, systemd unit and health checks. A fresh-host installation, restart and restore exercise remains to be run.
- [ ] **OPS-010** Keep private keys, credentials and test accounts out of Git. Runtime environment variants are ignored while `.env.example` stays public, and a regression covers environment files, recovery keys, generated account files and client caches. Arbitrary filenames and historical secret scanning remain open.
- [ ] **OPS-011** Check rollback and asset-cache behavior after client updates.
- [ ] **OPS-012** Document benchmark and browser limitations honestly.
- [ ] **OPS-013** Close the OpenAPI discovery gaps: five routes without route middleware, 21 unresolved response schemas and 260 missing response declarations.
- [ ] **PATCH-020** Integrate the held widget asset upload changes from the supplied `fosscord-changes.patch`: `src/api/routes/users/@me/widgets/assets/upload.ts`, `src/api/util/handlers/ProfileWidgetSelection.ts`, `src/cdn/routes/widget-assets.ts`, `src/util/util/WidgetUploads.ts` and its export in `src/util/util/index.ts`. The supplied upload parser runs before authorization, signed URLs allow replay, pending uploads have no durable reservation or expiry cleanup, saved files have no persistent quota and the public read buffers whole files. They need durable bounded reservations and storage accounting first.
- [ ] **TLS-001** Repair shared-port HTTP and HTTPS under Bun. Both answer plain HTTP but fail TLS negotiation on the same port. A separate `HTTPS_PORT` works for HTTP/2 and HTTP/1.1 and is the documented configuration until this is fixed.

## Loading customization (P1)

These settings apply to the whole instance, through the admin dashboard; no per-guild overrides were requested.

- [ ] **LOAD-006** Verify loading customization on desktop and mobile without remote asset requests.

## Security and storage (P0/P1)

These are audit targets, not findings. Record a reproducible exploit or a concrete missing enforcement boundary before calling one a vulnerability.

- [ ] **SEC-001** Audit account, per-file and instance aggregate storage bounds. The audit is in [security.md](security.md). Upload slots now expire, bots count toward their owner, stickers and data packages are bounded, replaced and removed images are deleted once nothing shows them, and a failed S3 write frees its reservation. Still open: a per-guild limit, attributing guild and admin images, the `system:managed` account that announcements fill, and default instance limits that 10 accounts can fill.
- [x] **SEC-002** Check concurrent upload quota reservations and failed-upload release. Raced live on PostgreSQL, see [security.md](security.md). A failed write on S3 now frees its reservation once the CDN has read the path back.
- [ ] **SEC-003** Audit attachment upload authentication, ownership and signed upload slots.
- [ ] **SEC-004** Bound multipart memory, field sizes and decompression/image processing.
- [ ] **SEC-005** Check remote asset fetching for SSRF, redirects and response size limits.
- [ ] **SEC-006** Verify path traversal and symlink containment for storage adapters.
- [ ] **SEC-007** Audit admin authorization and user impersonation boundaries.
- [ ] **SEC-008** Add meaningful regression checks for confirmed vulnerabilities and document remaining gaps.
- [ ] **SEC-015** Fix DNS rebinding and byte bounds in general public URL fetching, webhook avatars and embeds. The DNS-pinned helper is described in [limits.md](../security/limits.md#fetching-urls-that-users-pick); live integration and a full E2EE run are pending, and ActivityHost suffix matching and interaction transports remain separate review targets.

## Official inbox and announcements

- [ ] **ADM-016** Add authenticated downloads of official-DM attachments. Validate exact official membership and signed attachment metadata; stream decrypted bytes with no-store and filename safety; never return file keys to dashboard JSON. Test roundtrip and copied attachment/channel rejection.
- [ ] **ADM-017** Add official-send idempotency and ambiguous-network-result handling. Bind a stable request/message ID to operator/target/body fingerprint; retries must return the existing message without duplicate sends or altered-body acceptance.
- [ ] **ADM-018** Repair support actions in encrypted Official safety DMs. Standing overrides without a violation showed a raw embed-field dump and an empty call to action. Remaining: coordinated sender, client and E2EE integration and a native click check on new and legacy DMs with `SAFETY_CTA_SMOKE=1 scripts/dev/safety-cta-smoke.mjs`. No key or history migration and no plaintext fallback.
- [ ] **ADM-019** Replace the forced-ID Official inbox with a two-pane user directory and chat. Every ordinary user is searchable in pages of 50, Official incoming replies sort first by newest, then outgoing-only conversations, then other users, and narrow screens stack the panes. Remaining: a coordinated demo rollout and a native encrypted send and reply check through the official-inbox smoke.
- [ ] **QA-015** Capture official inbox narrow/mobile/keyboard render and real encrypted roundtrip evidence after integration. Verify drafts survive failed send and unsent draft navigation prompts.
- [ ] **PERF-018** Profile official history reads before allowing larger transcript pages. Pages hold 20 messages, and the helper verifies each persisted envelope and the managed sender. Measure query counts and identity and key reads, and optimize without removing per-message membership or signature validation.
- [ ] **PERF-019** Reduce Official history request work without caching keys or identities across requests. A request-local four-worker batch exists; live measurement and final integration are pending.
- [ ] **ANN-006** Finish native announcement file preview and inline image/video dimensions/duration parity.

## Verification rules

Run probes and smoke scripts against an instance and database you created for the test, never a production `.env`. Never clear global rate limits or reset another account to make a probe pass. Use disposable accounts and restore fixtures in awaited cleanup.

A source review, unit fixture, live API check and browser render answer different questions; claim only what the evidence shows. Run the client patch checker for plugin changes, scoped builds/lint/formatting for source changes, and required integration probes for the touched subsystem. Load tests must state fixture size, concurrency, duration, revision and host limits. Preserve credentials, key files, recovery codes and browser profiles outside version control.
