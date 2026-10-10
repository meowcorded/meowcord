const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { DataSource } = require("typeorm");
const frozen = Date.parse("2026-10-07T00:10:00.000Z");
class Clock extends Date {
    static now() {
        return frozen;
    }
}

function fixture(query) {
    const module = { exports: {} };
    const lifecycle = { eventEmitter: new EventEmitter() };
    const timers = [];
    const cleared = [];
    const errors = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/util/handlers/Instance.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            Date: Clock,
            console: { error: (...args) => errors.push(args) },
            setInterval: (run, delay) => {
                const timer = {
                    run,
                    delay,
                    unreferenced: false,
                    unref() {
                        this.unreferenced = true;
                    },
                };
                timers.push(timer);
                return timer;
            },
            clearInterval: (timer) => cleared.push(timer),
            require: (name) => {
                if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
                if (name === "@spacebar/database") return { getDatabase: () => ({ query }) };
                if (name === "../../../util/util/ProcessLifecycle") return { ProcessLifecycle: lifecycle };
                throw Error(name);
            },
        },
    );
    return { api: module.exports, lifecycle, timers, cleared, errors };
}

test("session cleanup coalesces work, retries failure and drains before shutdown", async () => {
    let finish;
    let fail;
    let calls = 0;
    const h = fixture(() => {
        calls++;
        return new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
        });
    });
    await h.api.initInstance();
    await h.api.initInstance();
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 300_000);
    assert.equal(h.timers[0].unreferenced, true);
    const first = h.api.pruneTemporarySessions();
    assert.equal(h.api.pruneTemporarySessions(), first);
    fail(new Error("fixture delete refused"));
    await assert.rejects(first, /fixture delete refused/);
    const pending = h.api.pruneTemporarySessions();
    let drained = false;
    const stop = h.lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => {
            drained = true;
        });
    h.timers[0].run();
    await Promise.resolve();
    assert.equal(drained, false);
    finish();
    await pending;
    await stop;
    await h.api.pruneTemporarySessions();
    assert.equal(calls, 2);
    assert.deepEqual(h.cleared, h.timers);
    assert.equal(h.errors.length, 0);
});

test("PostgreSQL session cleanup is bounded, protects ordinary sessions and skips another worker's locks", {
    skip: !process.env.INSTANCE_TEST_DATABASE,
    timeout: 30_000,
}, async (t) => {
    const schema = `instance_prune_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.INSTANCE_TEST_DATABASE, max: 1 });
    let database;
    let worker;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        database = new DataSource({
            type: "postgres",
            url: process.env.INSTANCE_TEST_DATABASE,
            poolSize: 3,
            extra: { options: `-c search_path=${schema}` },
        });
        await database.initialize();
        await database.query(`CREATE TABLE sessions (session_id text PRIMARY KEY,created_at timestamp NOT NULL,last_seen timestamp)`);
        const seed = async () => {
            await database.query("TRUNCATE sessions");
            await database.query(`INSERT INTO sessions SELECT 'expired-' || lpad(n::text,4,'0'), $1::timestamp - interval '2 hours', '1970-01-01' FROM generate_series(1,501) n`, [
                new Date(frozen).toISOString(),
            ]);
            await database.query(
                `INSERT INTO sessions VALUES ('boundary',$1::timestamp - interval '1 hour','1970-01-01'),('recent',$1::timestamp,'1970-01-01'),('ordinary',$1::timestamp - interval '2 hours',$1::timestamp),('unknown',$1::timestamp - interval '2 hours',NULL)`,
                [new Date(frozen).toISOString()],
            );
        };
        for (const timezone of ["UTC", "America/Los_Angeles"])
            await t.test(`strict expiry boundary and 500-row batches in ${timezone}`, async () => {
                await seed();
                await database.transaction(async (manager) => {
                    await manager.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
                    let queries = 0;
                    const h = fixture((sql, parameters) => {
                        queries++;
                        return manager.query(sql, parameters);
                    });
                    await h.api.pruneTemporarySessions();
                    assert.equal(queries, 1);
                    assert.equal(Number((await manager.query("SELECT count(*) AS count FROM sessions"))[0].count), 5);
                    await h.api.pruneTemporarySessions();
                    assert.equal(queries, 2);
                    const remaining = await manager.query("SELECT session_id FROM sessions ORDER BY session_id");
                    assert.deepEqual(
                        remaining.map((row) => row.session_id),
                        ["boundary", "ordinary", "recent", "unknown"],
                    );
                });
            });
        await t.test("simultaneous workers leave locked sessions with their current owner", async () => {
            await seed();
            worker = database.createQueryRunner();
            await worker.connect();
            await worker.startTransaction();
            const first = fixture((sql, parameters) => worker.query(sql, parameters));
            await first.api.pruneTemporarySessions();
            const second = fixture((sql, parameters) => database.query(sql, parameters));
            await second.api.pruneTemporarySessions();
            assert.equal(Number((await database.query("SELECT count(*) AS count FROM sessions WHERE session_id LIKE 'expired-%'"))[0].count), 500);
            await worker.commitTransaction();
            assert.equal(Number((await database.query("SELECT count(*) AS count FROM sessions"))[0].count), 4);
            await worker.release();
            worker = undefined;
        });
    } finally {
        if (worker?.isTransactionActive) await worker.rollbackTransaction();
        if (worker && !worker.isReleased) await worker.release();
        if (database?.isInitialized) await database.destroy();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    }
});
