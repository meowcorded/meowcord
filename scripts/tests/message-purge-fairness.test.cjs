const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { Pool } = require("pg");
const { DataSource } = require("typeorm");

function loadPurger(database, lifecycle = { eventEmitter: new (require("node:events").EventEmitter)() }, timers = {}) {
    const module = { exports: {} };
    const errors = [];
    const source = ts.transpileModule(fs.readFileSync("src/api/util/handlers/MessagePurge.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        setImmediate,
        ...timers,
        console: { error: (...args) => errors.push(args) },
        require(name) {
            if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
            if (name === "../../../util/util/ProcessLifecycle") return { ProcessLifecycle: lifecycle };
            if (name === "@spacebar/database") return { getDatabase: () => database };
            if (name === "@spacebar/util") return { GUILD_VERSION_HORIZON: 86_400_000 };
            throw new Error(`Unexpected import: ${name}`);
        },
    });
    return { ...module.exports, errors };
}

test("message purges rotate bounded batches and preserve work across simultaneous workers and failures", {
    skip: !process.env.MESSAGE_PURGE_TEST_DATABASE,
    timeout: 30_000,
}, async (t) => {
    const schema = `purge_fairness_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.MESSAGE_PURGE_TEST_DATABASE, max: 1 });
    let ds;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = new DataSource({
            type: "postgres",
            url: process.env.MESSAGE_PURGE_TEST_DATABASE,
            poolSize: 4,
            extra: { options: `-c search_path=${schema}` },
        });
        await ds.initialize();
        await ds.query("CREATE TABLE guild_entity_deletes (version bigint)");
        await ds.query("CREATE TABLE message_purges (channel_id bigint PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now())");
        await ds.query("CREATE TABLE messages (id bigint PRIMARY KEY,channel_id bigint)");
        const reset = async () => {
            await ds.query("TRUNCATE messages,message_purges");
            await ds.query("INSERT INTO message_purges VALUES (10,'2026-01-01'),(20,'2026-01-02')");
            await ds.query("INSERT INTO messages SELECT n,10 FROM generate_series(1,1200) n UNION ALL SELECT n,20 FROM generate_series(2001,2003) n");
        };
        const count = async (table, channel) => (await ds.query(`SELECT count(*)::int AS count FROM ${table} WHERE channel_id=$1`, [channel]))[0].count;
        const batches = [];
        const traced = {
            query: (sql, parameters) => ds.query(sql, parameters),
            transaction: (fn) =>
                ds.transaction((manager) =>
                    fn({
                        query: async (sql, parameters) => {
                            const result = await manager.query(sql, parameters);
                            if (sql.includes('DELETE FROM "messages"')) batches.push({ channel: parameters[0], count: result.length });
                            return result;
                        },
                    }),
                ),
        };
        await t.test("small purges finish after one large batch and every batch is at most 500 messages", async () => {
            await reset();
            const purger = loadPurger(traced);
            await purger.purgeDeletedChannels();
            assert.equal(purger.errors.length, 0);
            assert.deepEqual(
                batches.map((batch) => batch.channel),
                ["10", "20", "10", "10"],
            );
            assert.deepEqual(
                batches.map((batch) => batch.count),
                [500, 3, 500, 200],
            );
            assert.equal(await count("messages", "10"), 0);
            assert.equal(await count("messages", "20"), 0);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM message_purges"))[0].count, 0);
        });
        await t.test("another process skips the locked channel without dropping its remaining work", async () => {
            await reset();
            let release;
            let ready;
            const gate = new Promise((resolve) => {
                release = resolve;
            });
            const started = new Promise((resolve) => {
                ready = resolve;
            });
            let held = false;
            const first = loadPurger({
                query: traced.query,
                transaction: (fn) =>
                    ds.transaction((manager) =>
                        fn({
                            query: async (sql, parameters) => {
                                if (!held && sql.includes('DELETE FROM "messages"') && parameters[0] === "10") {
                                    held = true;
                                    ready();
                                    await gate;
                                }
                                return manager.query(sql, parameters);
                            },
                        }),
                    ),
            });
            const pending = first.purgeDeletedChannels();
            try {
                await started;
                const second = loadPurger(traced);
                await second.purgeDeletedChannels();
                assert.equal(second.errors.length, 0);
                assert.equal(await count("messages", "20"), 0);
                assert.equal(await count("messages", "10"), 1200);
                assert.equal(await count("message_purges", "10"), 1);
            } finally {
                release();
                await pending;
            }
            assert.equal(first.errors.length, 0);
            assert.equal(await count("messages", "10"), 0);
            assert.equal(await count("message_purges", "10"), 0);
        });
        await t.test("a rejected delete rolls back the queue timestamp and remains retryable", async () => {
            await reset();
            await ds.query("CREATE FUNCTION refuse_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected purge failure'; END $$");
            await ds.query("CREATE TRIGGER refuse_purge BEFORE DELETE ON messages FOR EACH ROW EXECUTE FUNCTION refuse_purge()");
            const purger = loadPurger(traced);
            try {
                await purger.purgeDeletedChannels();
                assert.equal(purger.errors.length, 1);
                assert.equal(await count("messages", "10"), 1200);
                assert.equal(await count("message_purges", "10"), 1);
                assert.equal((await ds.query("SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day FROM message_purges WHERE channel_id=10"))[0].day, "2026-01-01");
            } finally {
                await ds.query("DROP TRIGGER refuse_purge ON messages");
            }
            await purger.purgeDeletedChannels();
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM messages"))[0].count, 0);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM message_purges"))[0].count, 0);
        });
    } finally {
        if (ds?.isInitialized) await ds.destroy();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    }
});

test("message purger cancels timers and finishes the current transaction before shutdown", async () => {
    const lifecycle = { eventEmitter: new (require("node:events").EventEmitter)() };
    const timers = [];
    const cleared = [];
    let finish;
    let batches = 0;
    const api = loadPurger(
        {
            query: async () => [],
            transaction: () => {
                batches++;
                return new Promise((resolve) => {
                    finish = resolve;
                });
            },
        },
        lifecycle,
        {
            setTimeout: (run) => {
                const timer = { run };
                timers.push(timer);
                return timer;
            },
            setInterval: (run) => {
                const timer = { run };
                timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => cleared.push(timer),
            clearInterval: (timer) => cleared.push(timer),
        },
    );
    const timer = api.startMessagePurger();
    assert.equal(api.startMessagePurger(), timer);
    const work = api.purgeDeletedChannels();
    await new Promise(setImmediate);
    let drained = false;
    const stop = lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => {
            drained = true;
        });
    timers.forEach(({ run }) => run());
    await Promise.resolve();
    assert.equal(drained, false);
    assert.deepEqual(cleared, timers);
    finish(true);
    await work;
    await stop;
    await api.purgeDeletedChannels();
    assert.equal(batches, 1);
    assert.equal(api.errors.length, 0);
});
