# Documentation

## Self-hosting

- [databases.md](self-hosting/databases.md): PostgreSQL and SQLite selection, migrations and backups.
- [setup.md](self-hosting/setup.md): Docker and development setup, and the first operator account.
- [deploy.md](self-hosting/deploy.md): production with Docker Compose, backups, updates, reverse proxies and phones.
- [external-services.md](self-hosting/external-services.md): every outside service the instance can contact and how each is turned on.
- [stickers.md](self-hosting/stickers.md): provisioning the standard sticker artwork locally.

## Features

- [admin.md](features/admin.md): the admin dashboard at `/admin`.
- [activities.md](features/activities.md): embedded activities, their hosting and API.
- [announcements.md](features/announcements.md): encrypted announcements from the official account.
- [e2ee.md](features/e2ee.md): end-to-end encrypted DMs, key backup and recovery.
- [homepage.md](features/homepage.md): the instance homepage at `/` and the settings that change it.
- [identity-moderation.md](features/identity-moderation.md): blocked words in usernames, display names and nicknames.
- [loading-screen.md](features/loading-screen.md): custom loading tips and loading animation.
- [notifications.md](features/notifications.md): notification settings, mention counts, read states and Web Push.
- [pride-badges.md](features/pride-badges.md): the pride flag catalog and picking flags at signup.
- [profile-widgets.md](features/profile-widgets.md): application profile widgets made in the developer portal.
- [signup.md](features/signup.md): Cap verification on registration.

## Security

- [upload-limits.md](security/upload-limits.md): attachment upload slots and per-user staging limits.
- [upload-buffering.md](security/upload-buffering.md): memory admission for CDN uploads.
- [cloud-attachments.md](security/cloud-attachments.md): who can turn a cloud upload into a message attachment.
- [public-url-fetching.md](security/public-url-fetching.md): the bounded, DNS-pinned helper for outbound requests.
- [remote-media.md](security/remote-media.md): message component media downloads.
- [image-decoding.md](security/image-decoding.md): limits on images the server decodes itself.

## Development

- [client-patches.md](development/client-patches.md): how the Discord client is patched, built and checked.
- [native-ui.md](development/native-ui.md): shared native UI adapters for plugins.
- [dialog-dismissal.md](development/dialog-dismissal.md): how owned dialogs dismiss and how the developer portal handles late responses.
- [parity.md](development/parity.md): every Discord feature and its state here.
- [work-backlog.md](development/work-backlog.md): the task queue.
- [admin-api-coverage.md](development/admin-api-coverage.md): which API operations the admin dashboard covers, with the [machine-readable map](development/admin-api-coverage.json).
