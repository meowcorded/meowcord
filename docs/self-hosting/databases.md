# Databases

The server supports PostgreSQL and SQLite. Set `DATABASE` before starting the server. PostgreSQL remains the default in Docker Compose and the development setup script. Existing PostgreSQL installations keep their connection string and migrations.

| Backend | Connection string |
| --- | --- |
| PostgreSQL | `postgres://user:password@localhost:5432/meowcord` |
| SQLite, relative path | `sqlite:db/meowcord.sqlite` |
| SQLite, absolute path | `sqlite:/var/lib/meowcord/meowcord.sqlite` |

SQLite uses Bun's built-in driver. It needs no PostgreSQL service or additional database package. Relative paths resolve from the server's working directory. The parent directory is created on startup. The server enables foreign keys, WAL journaling and a 30 second busy timeout. Keep the database on local storage and run one bundled server process for a SQLite instance.

Both backends apply their own versioned migrations automatically. SQLite creates its schema on first start without `DB_SYNC`. Do not enable `DB_SYNC` for routine operation. SQLite stores arrays and JSON as JSON text and preserves 64-bit account, server, channel and message IDs. Transactions serialize SQLite mutations, including encryption and slowmode checks. PostgreSQL keeps its row locks and advisory locks.

For a local SQLite instance, install dependencies and build as described in [setup.md](setup.md). Set these values in `.env`:

```dotenv
DATABASE=sqlite:db/meowcord.sqlite
CONFIG_PATH=config.json
PORT=3001
THREADS=1
```

For the local example, create `config.json`:

```json
{
    "general": { "serverName": "http://localhost:3001" },
    "api": { "endpointPublic": "http://localhost:3001/api/v9" },
    "cdn": { "endpointPublic": "http://localhost:3001", "endpointPrivate": "http://localhost:3001" },
    "gateway": { "endpointPublic": "ws://localhost:3001" }
}
```

Run `bun start`. Set the URLs to your own instance when hosting publicly. Provision the operator account with `bun scripts/ops/operator.mjs grant <account-id>` on either backend.

Changing `DATABASE` selects another database. It does not copy existing accounts or messages between backends. Use a fresh SQLite file when creating a new instance. The PostgreSQL development setup script still creates and owns a PostgreSQL database.

Stop the server before copying the SQLite database and its `-wal` and `-shm` companion files. Back up the configuration, attachment storage and encryption recovery key too. Keep the file private: it contains account and instance data. SQLite files under `db/`, files ending in `.sqlite` and their journal companions are ignored by Git.

`bun test scripts/tests/sqlite-database.test.cjs` creates and removes its own temporary SQLite database. PostgreSQL tests use the guarded database variables documented in [CONTRIBUTING.MD](../../CONTRIBUTING.MD). Never clear rows on a database you did not create for the test run.
