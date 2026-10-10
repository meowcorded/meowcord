# Meowcord work backlog

This is the task queue for admin, app, compatibility, reliability and performance work. Each entry is a planned investigation or an acceptance target, not a claim that a confirmed bug exists. Source pointers say where to start. Remove an entry once its behavior is verified and shipped, and update the feature doc that describes it.

P0 means a reported crash, trapped flow or broken core interaction. P1 means active completeness, reliability or measured performance work. P2 means polish and consolidation. Task IDs stay the same when priorities change.

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

Start with `src/api/util/utility/prideBadges.ts; client/plugins/fosscordPride`.

- [ ] **FLAG-007** Verify badges render in compact and expanded profiles.
- [ ] **FLAG-008** Check selection search, keyboard interaction and empty results.
- [ ] **FLAG-012** Measure profile badge rendering with a large selection.
- [ ] **QA-016** Check that default and profile badge artwork is available without runtime upstream requests. Sample each configured and default badge on the current deployment, keep custom images, and don't broadly enable upstream fetching.

## Admin navigation and lists (P1)

Start with `assets/public/admin/admin.js; src/api/routes/admin`.

- [ ] **ADM-009** Add bounded or cursor pagination for very large lists.
- [ ] **ADM-010** Check keyboard navigation, labels and mobile table overflow.
- [ ] **ADM-012** Inventory every drawer field against server validation.
- [ ] **ADM-013** Provide useful empty states with one relevant action.
- [ ] **ADM-014** Verify permission-restricted navigation and direct links.

## User administration (P1)

Start with `docs/development/admin-api-coverage.md; src/api/routes/admin/users`.

- [ ] **USR-001** Inventory remaining per-user API coverage with exact evidence.
- [ ] **USR-002** Make preference writes and audit records transactional.
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

## Shop and packs (P1)

Start with `src/api/routes/admin/store; assets/public/admin`.

- [ ] **SHOP-004** Add clear preview and validation for artwork uploads. Refused frame replacements already keep the old layers; preview work remains.
- [ ] **SHOP-006** Keep Discord decoration assets free in the local shop.
- [ ] **SHOP-007** Add server-free sticker and emoji packs.
- [ ] **SHOP-008** Define ownership, visibility and sharing for server-free expression packs.
- [ ] **SHOP-009** Add import and export for local pack metadata.
- [ ] **SHOP-010** Check shop rendering with thousands of items.
- [ ] **SHOP-011** Bound item and pack administration responses.
- [ ] **SHOP-014** Verify profile frames, effects and nameplates across profile layouts.
- [ ] **STICKER-003** Support independent sticker and emoji packs that don't require a guild.

## Server administration (P1)

Start with `docs/development/admin-api-coverage.md; src/api/routes/admin/guilds`.

- [ ] **GUILD-001** Add member search and paginated member administration.
- [ ] **GUILD-002** Expose channel permission-overwrite management.
- [ ] **GUILD-003** Expose complete thread and forum settings.
- [ ] **GUILD-004** Expose invite lifecycle controls.
- [ ] **GUILD-005** Expose ban, unban and timeout controls with audit entries.
- [ ] **GUILD-006** Expose emoji and sticker management.
- [ ] **GUILD-007** Expose soundboard management.
- [ ] **GUILD-008** Expose scheduled-event management.
- [ ] **GUILD-009** Expose onboarding configuration and prompts.
- [ ] **GUILD-010** Expose member applications and join-request review.
- [ ] **GUILD-011** Expose integrations and webhook settings with scoped rights.
- [ ] **GUILD-012** Verify ownership transfer and operator-target safeguards.
- [ ] **GUILD-013** Check server features against client-supported values.
- [ ] **GUILD-014** Verify mutations reach active clients through gateway events.

## Performance and bounded work (P1)

Start with `docs/features/admin.md; src/api/util/handlers`.

- [ ] **PERF-001** Measure current slow routes with realistic isolated fixtures.
- [ ] **PERF-002** Record baseline query counts before each optimization.
- [ ] **PERF-005** Bound interaction HTTP execution with an end-to-end deadline.
- [ ] **PERF-007** Bound gateway outbound and replay byte budgets.
- [ ] **PERF-008** Bound channel history and search relation loading.
- [ ] **PERF-009** Measure short-term search and expensive exact counts.
- [ ] **PERF-010** Bound encryption plaintext caches and key lookup batches.
- [ ] **PERF-011** Add CDN cache quotas and eviction measurements.
- [ ] **PERF-012** Bound ffmpeg work queues and API-to-CDN upload deadlines.
- [ ] **PERF-013** Avoid global voice locks around network work.
- [ ] **PERF-014** Index SFU subscribers instead of repeatedly snapshotting all peers.
- [ ] **PERF-015** Measure admin search and drawer latency under concurrency.
- [ ] **PERF-016** Keep benchmark claims tied to fixture size, host and revision.
- [ ] **PERF-017** Integrate bounded compression for public E2EE, admin and portal files. Remaining: a coordinated demo build and measurement of live response headers and bodies.
- [ ] **PERF-020** Keep gateway resume state usable across processes instead of process-local.
- [ ] **PERF-021** Support lazy member lists for servers above 5,000 members.

## Background jobs and reliability (P1)

Start with `docs/features/admin.md; src/util`.

- [ ] **JOB-001** Make scheduled-message publication durably idempotent.
- [ ] **JOB-002** Verify scheduler behavior across simultaneous workers.
- [ ] **JOB-007** Cancel replaced-track readers in the SFU.
- [ ] **JOB-008** Bound retry queues and backoff under dependency failure. The Unix, RabbitMQ and JSON worker queues and the image decoding paths have limits, described in [deploy.md](../self-hosting/deploy.md) and [image-decoding.md](../security/image-decoding.md). Other codecs, nested and vendor metadata parsing, decoder overhead, filesystem open and stat stalls, duplicate waiters and the remaining dependency queues still need an audit.
- [ ] **JOB-009** Make shutdown drain tasks without hanging indefinitely. Lifecycle work, timers, transports and workers drain on SIGTERM and SIGINT, and a 30-second watchdog forces exit, see [deploy.md](../self-hosting/deploy.md#shutdown). The remaining background timer audit stays open.
- [ ] **JOB-010** Audit process-local interaction state for horizontal scaling.
- [ ] **JOB-011** Document job ownership, deadlines and failure recovery.
- [ ] **JOB-017** Order concurrent message sends consistently for last-message pointers and nonces.

## Compatibility and app behavior (P1)

Start with `docs/development/parity.md; client/plugins; client/equicord-patches`.

- [ ] **APP-001** Run current native patch checks after plugin changes.
- [ ] **APP-002** Keep required native patches compatible with upstream build changes.
- [ ] **APP-005** Verify profile banner preview outside expanded profiles.
- [ ] **APP-006** Verify themes and contrast across every custom component.
- [ ] **APP-007** Check iPhone registration and desktop registration flows.
- [ ] **APP-008** Check Android-sized navigation and settings layouts.
- [ ] **APP-009** Check reduced-motion and keyboard-only behavior.
- [ ] **APP-010** Verify account and server customization updates without reload.
- [ ] **APP-011** Keep guild messaging behavior intact while private chats require encryption.
- [ ] **APP-012** Audit safe clipboard and download behavior on mobile Safari.
- [ ] Serialize concurrent role hierarchy mutations, finish bot privileged intent approval and MESSAGE_CONTENT projection, and check the native user and guild report entry points.
- [ ] **APP-024** Check H.264 negotiation compatibility in the SFU.

## GIFs and external dependencies (P1)

Start with `docs/self-hosting/external-services.md; client/plugins; src/api/routes/gifs`.

- [ ] **GIF-001** Verify Klipy search, categories and pagination with a configured key.
- [ ] **GIF-002** Verify Tenor fallback and provider selection.
- [ ] **GIF-003** Persist the Klipy key only in operator settings.
- [ ] **GIF-004** Keep credentials out of public settings and logs.
- [ ] **GIF-005** Show a useful empty state when the chosen provider is unavailable.
- [ ] **GIF-007** Audit all remaining runtime third-party requests.
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

Start with `CONTRIBUTING.MD; docs/self-hosting/native.md; docs/self-hosting/deploy.md; scripts/client.js`.

- [ ] **OPS-001** Refresh upstream history and report whether new commits need integration.
- [ ] **OPS-002** Keep normal pushes directly to main within the user-authorized workflow.
- [ ] **OPS-003** Commit verified changes in small coherent batches.
- [ ] **OPS-005** Keep localhost demo source synchronized with committed main.
- [ ] **OPS-007** Document safe current commands for encryption fixtures.
- [ ] **OPS-008** Publish complete versioned client asset snapshots.
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

- [ ] **SEC-001** Audit account, per-file and instance aggregate storage bounds.
- [ ] **SEC-002** Check concurrent upload quota reservations and failed-upload release.
- [ ] **SEC-003** Audit attachment upload authentication, ownership and signed upload slots.
- [ ] **SEC-004** Bound multipart memory, field sizes and decompression/image processing.
- [ ] **SEC-005** Check remote asset fetching for SSRF, redirects and response size limits.
- [ ] **SEC-006** Verify path traversal and symlink containment for storage adapters.
- [ ] **SEC-007** Audit admin authorization and user impersonation boundaries.
- [ ] **SEC-008** Add meaningful regression checks for confirmed vulnerabilities and document remaining gaps.
- [ ] **SEC-015** Fix DNS rebinding and byte bounds in general public URL fetching, webhook avatars and embeds. The DNS-pinned helper is described in [public-url-fetching.md](../security/public-url-fetching.md); live integration and a full E2EE run are pending, and ActivityHost suffix matching and interaction transports remain separate review targets.

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
