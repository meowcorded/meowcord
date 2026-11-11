# End-to-end encrypted messages

Every DM and group DM encrypts new messages and attachments, and nobody can turn it off. That includes messages from bots, applications and webhooks in private channels, and DMs with people on other instances. Guild channels are not encrypted. Messages sent before a conversation was encrypted stay in plaintext.

Users set nothing up. Signing up or logging in creates or unlocks the key backup.

## Security model

By default `limits.e2ee.trustServerByDefault` is `true` and the server is trusted. Encryption then protects messages from a stolen database or a passive observer, but the operator can read message content in these cases:

- The server keeps a recovery copy of every user's backup secret, encrypted under a recovery master key that lives outside the database. Whoever holds both the database and that key can open every backup, and with it every message key.
- The server serves the client JavaScript, so a malicious operator can ship a client that leaks keys. Every web E2EE design has this limit.
- The client trusts the server's key directory, so a compromised server could swap a contact's identity key or approve a new device of the same account unseen.

Otherwise the operator sees only metadata: who talks to whom and when, sizes, reactions, pins, typing, read state, replies, mentioned members, stickers loaded from the CDN and the links whose previews a reader asks for.

The advanced option "Review safety number changes and new browser approvals" in User Settings > Encryption turns on strict mode for that browser. Strict mode pins each contact's identity key and blocks sending when it changes until the user reviews the safety number. It asks the user to approve new browsers with a six-digit code, and it never uploads or fetches a recovery copy. Setting `trustServerByDefault` to `false` makes strict mode the default for every browser and turns the recovery endpoints off.

## Cryptography

For each message the sending browser encrypts the payload with a random 256-bit content key in AES-256-GCM. It wraps the content key to each recipient device's signed X25519 prekey with HPKE base mode and signs the envelope with its Ed25519 device key. Keys are non-extractable WebCrypto keys in IndexedDB.

| Key | Type | Scope |
| --- | --- | --- |
| Identity key | Ed25519 | One per user. It signs the user's devices, and safety numbers are computed over it. |
| Device key | Ed25519 | One per browser profile and origin. |
| Signed prekey | X25519 | Rotated every 7 days. A retired private prekey is deleted 30 days later. |

There is no per-message forward secrecy beyond prekey rotation.

The additional authenticated data binds the channel, the sender, the sender device and the nonce, so a ciphertext can't be moved to another channel or replayed. The server writes `🔒 Encrypted message` into `content`, so mentions, search and push notifications never see plaintext. Safety numbers are 60 digits in Signal's format, compared by voice or in person. A contact marked as verified stays verified in the user's other browsers.

## Devices

Each browser profile is a device. Other browsers only encrypt to a new device once the user's identity key, from the backup or another browser, signs it.

Each device belongs to the session that registered it, and logging that session out in any way revokes the device. A browser that finds its own device revoked deletes its keys, and User Settings > Log Out deletes them right away. The server revokes a pending device when its session ends or after `limits.e2ee.pendingDeviceTtlHours`. User Settings > Encryption lists the devices, and removing one revokes it and logs its session out.

## Key backup and recovery

The backup lets a new browser sign itself and read older messages. It holds the user's identity private key and a backup private key, sealed under a random 32-byte backup secret, and the server stores one per user. Every envelope also seals its content key to each member's backup public key, so a browser that opens the backup can read the whole history.

### Password

By default the browser seals the backup secret under a key derived from the account password with Argon2id, using 64 MiB, 3 iterations and parallelism 1. A new browser unlocks the backup at login without a prompt, and a password change reseals the secret. Anyone with a copy of the database can guess passwords offline at one Argon2id run per guess, so a weak password makes a weak backup.

### Recovery code

User Settings > Encryption can switch the backup to a recovery code of 32 Crockford base32 characters, about 160 bits, shown once. After the user confirms with "I saved it", the password no longer opens the backup. A user who loses the code and every signed-in browser, with no server recovery copy, loses the history.

### Server recovery copy

In default mode an unlocked browser publishes its backup secret to the server, signed by the identity key. The server stores it encrypted under the recovery master key. A new browser can get the secret back with the current account password, even when the backup uses a recovery code. A copy only exists after a browser published it, and resetting encryption or deleting the account removes it.

The server reads the 32-byte recovery master key from the first of these that is set:

| Source | Notes |
| --- | --- |
| `E2EE_RECOVERY_MASTER_KEY` | 64 hex characters or 32 bytes in base64url. |
| `E2EE_RECOVERY_KEY_FILE` | Path to a file holding the key in either format. |
| `.e2ee-recovery.key` next to `CONFIG_PATH` | The default. Docker keeps it in the `state` volume. |

The server creates the default file with mode 600 the first time it needs the key, but only while no recovery copies exist, because a new key couldn't open them. The file must be a regular file of at most 128 bytes with no group or other permissions, and not a symlink. When the key is missing or invalid, the recovery endpoints answer `503` and store nothing. Back the key up separately from the database, as [setup.md](../self-hosting/setup.md#data-and-backups) describes.

### Approval from another browser

A locked browser can ask the user's other signed-in browsers for the backup secret. The new browser commits to its X25519 key first, so the server can't pick keys that make the codes match. In default mode an unlocked browser approves automatically when the requesting device belongs to a live session of the same account. In strict mode every unlocked browser shows the new login with its location and a six-digit code, and the user picks Approve or Deny. Deny revokes the device and signs its session out.

### Resetting encryption

When nothing can unlock the backup, "Reset encryption" in the unlock dialog or in User Settings > Encryption starts over after asking for the account password. The server revokes every device and deletes the backup, the stored message keys and the recovery copy. The user's own browsers then show old messages as "Sent before encryption was reset". Contacts keep reading what they already received, and contacts in strict mode see a safety number change.

## What users see

When a send can't be encrypted, the draft stays in the composer with an error, and nothing is sent in plaintext.

Network failures during encryption startup pause sending and retry with backoff instead of permanently disabling encryption in that tab. Failed message key requests retry after 30 seconds, or the server's longer rate-limit delay. A later rate limit extends an earlier retry deadline, and reconnect or online recovery does not bypass that deadline. The retry queue holds at most 256 messages. When it is full, the oldest messages are marked failed and the channel's recent history is fetched again on the next retry. Gateway reconnects and the browser's online event invalidate cached key directories and retry queued messages. Invalid signatures and malformed ciphertext are not retried as network failures.

A member who never signed in since encryption existed has no keys and can't read new messages. When every other member is in that state, the browser refuses the send and names them. Otherwise the message goes to the rest with a warning that names them.

These work in encrypted conversations too:

- Attachments, stickers and voice messages. The browser encrypts files in 64 KiB chunks before upload, so the server only sees an opaque `.bin` file of the same size plus 16 bytes per chunk. A service worker at `/e2ee-sw.js` decrypts them for display.
- Mentions. The sending browser lists up to 100 mentioned members in the envelope in plaintext, so badges and push notifications work.
- Search. The browser decrypts the channel's last 1000 messages and searches them, and the query never reaches the server. Contains filters match decrypted attachment types, links and stickers. The media, files and links tabs use the same local filters. Multiple contains types combine with OR, and exclusions combine with AND. Media searches wait up to 10 seconds for link previews already being fetched, so a preview that arrives during the search is not silently omitted.
- Link previews. The reader's browser sends up to 5 links to `POST /e2ee/embeds` and gets their previews back. The server stores no embed on the message.

Concurrent preview requests for the same link share one fetch. Local encrypted attachment URLs are not fetched as public preview images.

The attachment worker includes same-origin cookies when fetching ciphertext so authenticated reverse proxies can authorize media requests. Cross-origin fetches do not include cookies.

Encrypted video thumbnails are rendered in the browser. The attachment worker allows 20 seconds for a thumbnail response, longer than the renderer's 10 second deadline. Failed attachment responses are not cached and identify missing keys, unavailable ciphertext or an unavailable preview in the `X-E2EE-Error` header.

Polls, clips, forwards, components and text-to-speech are not available.

## Members who left a group

Every message is encrypted to every member at send time, so remaining members can still read messages from someone who left. To check their signatures, the server keeps answering key requests about a former member to current members of that channel only.

Across instances the former member's home answers when the asking instance hosts the group or still has a user in it, and an instance keeps its cached copy of the keys when the home refuses. A third instance that never cached the keys gets nothing once the home's last local member has left the group. ENC-022 in the [work backlog](../development/work-backlog.md) tracks that gap.

## Conversations with users of other instances

A DM or group DM with someone on another [federated](federation.md) instance is encrypted from its first message. The instance where it started hosts it and stores the ciphertext, and each other member's home keeps a mirror. A home never turns encryption off on a mirror and refuses to relay a message or edit without an envelope, so a malicious host can't downgrade the conversation.

These conversations use version 2 envelopes, which sign canonical `@snowflake@instance` ids because local ids differ on each instance. [federation-protocol.md](../development/federation-protocol.md) has the format.

Each instance fetches a remote user's keys from that user's home and caches them for 10 minutes. The home only answers instances that share a DM, a group DM or a friendship with the user, or host a conversation the user is in. Adding someone to an encrypted group DM fails with `E2EE_RECIPIENT_NO_DEVICES` when their instance returns no active device. In default mode a browser trusts both its own instance and the contact's home for key changes, and strict mode pins the key against both.

No instance gets a content key, except through a report.

## Reporting encrypted messages

When a user reports a message in an encrypted conversation, their browser sends the content keys of the reported message and of the messages around it, at most 50 in all. The server checks that the sender's device belonged to the author and was active at the time, verifies the signature and decrypts the stored ciphertext. It saves up to 4000 characters of text and up to 10 file names in the report and never stores the keys, so a reporter can't change what the message says.

The admin dashboard shows a report that passes as "Verified encrypted text", and one with a missing or wrong key or a bad signature as "Encrypted, not verified" with the reason. A report about a conversation hosted on another instance goes to the host, which verifies it the same way. Instance automod only acts on a verified report, as [automod.md](automod.md#encrypted-messages) describes.

## Limits

Operators set these under `limits.e2ee` in the config, or on the Encrypted DMs card of the admin dashboard's Site settings page, which has no switch for `trustServerByDefault`. New values apply without a restart.

| Key | Default | Meaning |
| --- | --- | --- |
| `trustServerByDefault` | `true` | `false` makes strict mode the default and turns off recovery copies. |
| `maxEnvelopeBytes` | `65536` | Largest encrypted envelope in bytes. |
| `maxEnvelopeDevices` | `256` | Recipient devices one message can be encrypted for. |
| `pendingDeviceTtlHours` | `168` | Hours before an unapproved device is revoked. |
| `deviceRegistrationsPerHour` | `30` | New devices per account per hour. |
| `deviceUpdatesPerHour` | `60` | Device re-signs per account per hour. |
| `keyQueriesPerMinute` | `60` | Key directory lookups per account per minute. |

## Error codes

The message endpoints answer these codes. The device, identity and backup endpoints use 90005 to 90015, listed in `src/api/util/utility/e2ee.ts`.

| Code | Name | Meaning |
| --- | --- | --- |
| 90001 | `E2EE_DEVICE_MISMATCH` | The envelope skipped an active device. The client refetches keys and retries. |
| 90002 | `E2EE_REQUIRED` | A plaintext message was sent into an encrypted conversation. |
| 90003 | `E2EE_INVALID_ENVELOPE` | The envelope is malformed or has the wrong version. |
| 90004 | `E2EE_UNSUPPORTED` | Polls, forwards, components, text-to-speech or plaintext stickers. The recovery endpoints also answer it when `trustServerByDefault` is `false`. |
| 90007 | `E2EE_RECIPIENT_NO_DEVICES` | A member has no active device. The response lists their `user_ids`. |
| 90016 | `E2EE_PLAINTEXT_ATTACHMENT` | An attachment wasn't an opaque `.bin` file or carried plaintext metadata, such as a clip's fields. |

## Discord's Android app

The mobile bundle handles encrypted text but not attachments, approvals or safety numbers, as [android-client.md](../development/android-client.md#encrypted-dms) describes.

## For contributors

`bun run build:e2ee` bundles the engine in `client/e2ee`, `assets/client_patches/10-e2ee-loader.js` loads it, and the `FosscordE2ee` plugin adds the UI. The loader finds Discord's modules by shape. When it can't find a hook, the client shows "Encryption is unavailable in this client build" and refuses to send in encrypted channels. `bun run generate:client` checks the hooks against every new client build. [client-patches.md](../development/client-patches.md) has the rules for changing it.

Run the browser tests from a terminal or through `scripts/dev/outside-app.sh`:

```sh
PORT=<port> E2EE_TEST_DATABASE_NAME=<db> bun scripts/dev/e2ee-test.mjs
bun scripts/dev/federation-e2ee-test.mjs
```

`e2ee-test.mjs` refuses to run unless the database in `.env` is named `E2EE_TEST_DATABASE_NAME`, `fosscord_codex_admin` by default. `federation-e2ee-test.mjs` tests two instances on new databases, `meowcord_fed_e2ee_a` and `meowcord_fed_e2ee_b` unless `FED_DB_A` and `FED_DB_B` say otherwise. It refuses ones that already exist and drops them at the end unless `FED_KEEP` is set. The unit tests in `scripts/tests/e2ee-*.test.cjs` and `encrypted-report.test.cjs` run with `bun run test`.
