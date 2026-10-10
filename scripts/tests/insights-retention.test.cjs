const assert = require("node:assert/strict");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { Pool } = require("pg");
const { DataSource } = require("typeorm");

function loadInsights(query, transaction, clock = Date, lifecycle = { eventEmitter: new (require("node:events").EventEmitter)() }, timers = {}) {
    const filename = path.resolve(__dirname, "../../src/database/insights/GuildInsights.ts");
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(
        js,
        {
            module,
            exports: module.exports,
            console,
            Date: clock,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval,
            ...timers,
            require(name) {
                if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
                if (name === "../../util/util/ProcessLifecycle") return { ProcessLifecycle: lifecycle };
                if (name === "../Database") return { getDatabase: () => ({ query, transaction }) };
                if (name === "lambert-server/HTTPError")
                    return {
                        HTTPError: class extends Error {
                            constructor(message, status) {
                                super(message);
                                this.status = status;
                            }
                        },
                    };
                if (name === "@spacebar/util/util/Snowflake") return { Snowflake: { EPOCH: 1420070400000 } };
                throw new Error(`Unexpected import: ${name}`);
            },
        },
        { filename },
    );
    return module.exports.GuildInsights;
}

const DAY = 86_400_000;
const normalize = (value) => JSON.parse(JSON.stringify(value));

test("historical retention reads one grouped membership scan with unchanged cohort semantics", { skip: !process.env.INSIGHTS_TEST_DATABASE, timeout: 30_000 }, async (t) => {
    const schema = `insights_retention_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.INSIGHTS_TEST_DATABASE, max: 1 });
    let ds;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = new DataSource({
            type: "postgres",
            url: process.env.INSIGHTS_TEST_DATABASE,
            poolSize: 1,
            extra: { options: `-c search_path=${schema}` },
        });
        await ds.initialize();
        const today = new Date().toISOString().slice(0, 10);
        const dayAt = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
        const start = dayAt(-107);
        const end = dayAt(-8);
        await ds.query(`CREATE TABLE members (guild_id bigint, id bigint, joined_at timestamp NOT NULL, PRIMARY KEY (id, guild_id))`);
        await ds.query(`CREATE INDEX ON members (guild_id)`);
        await ds.query(`CREATE TABLE guild_insights_daily (guild_id bigint, day date, metric varchar, key varchar, value bigint)`);
        await ds.query(`CREATE TABLE guild_insights_rollups (day date)`);
        await ds.query(`CREATE TABLE voice_states (guild_id bigint, channel_id bigint, connected_at bigint)`);
        await ds.query(
            `INSERT INTO members SELECT g, d * 10000 + u, $1::date + d * interval '1 day' + (u - 1) * interval '86.4 seconds'
            FROM generate_series(0, 99) d CROSS JOIN generate_series(1, 1000) u CROSS JOIN generate_series(1, 2) g`,
            [start],
        );
        await ds.query(`INSERT INTO guild_insights_daily SELECT 1, $1::date + d * interval '1 day', 'joins', '', 1100 FROM generate_series(0, 99) d`, [start]);
        await ds.query(`ANALYZE members`);
        let queries = 0;
        let sqlMs = 0;
        const query = async (sql, parameters) => {
            queries++;
            const started = performance.now();
            try {
                return await ds.query(sql, parameters);
            } finally {
                sqlMs += performance.now() - started;
            }
        };
        const Insights = loadInsights(query);
        await t.test("100 cohort queries become one query and match the existing per-day result", async () => {
            const baseline = new Map();
            queries = 0;
            sqlMs = 0;
            for (let i = 0; i < 100; i++) {
                const day = dayAt(-107 + i);
                baseline.set(day, (await Insights.retained(day, "1")).get("1") ?? 0);
            }
            assert.equal(queries, 100);
            const baselineSqlMs = sqlMs;
            queries = 0;
            sqlMs = 0;
            const grouped = await Insights.retainedByDay("1", start, dayAt(-7));
            assert.equal(queries, 1);
            assert.deepEqual(normalize([...grouped].sort()), normalize([...baseline].sort()));
            t.diagnostic(
                JSON.stringify({
                    fixtureMembers: 200_000,
                    cohortDays: 100,
                    baselineQueries: 100,
                    groupedQueries: 1,
                    baselineSqlMs,
                    groupedSqlMs: sqlMs,
                }),
            );
        });

        await t.test("daily reports use four queries across all 100 cohorts", async () => {
            queries = 0;
            sqlMs = 0;
            const daily = await Insights.daily("1", start, end);
            assert.equal(queries, 4);
            assert.equal(daily.size, 100);
            for (const metrics of daily.values()) assert.equal(metrics.retained[""], 1000);
            t.diagnostic(JSON.stringify({ dailyQueries: queries, dailySqlMs: sqlMs }));
        });

        await t.test("UTC half-open edges, zero-member cohorts and stored counts retain their behavior", async () => {
            const emptyDay = dayAt(-57);
            const storedDay = dayAt(-77);
            const noJoinsDay = dayAt(-67);
            await ds.query(`DELETE FROM members WHERE guild_id = 1 AND joined_at >= $1::date AND joined_at < $1::date + interval '1 day'`, [emptyDay]);
            await ds.query(
                `INSERT INTO members VALUES (1, 2000001, $1::date - interval '1 millisecond'), (1, 2000002, $1::date),
                (1, 2000003, $2::date + interval '1 day' - interval '1 millisecond'), (1, 2000004, $2::date + interval '1 day')`,
                [start, end],
            );
            await ds.query(`INSERT INTO guild_insights_daily VALUES (1, $1, 'retained', '', 77)`, [storedDay]);
            await ds.query(`UPDATE guild_insights_daily SET value = 0 WHERE day = $1 AND metric = 'joins'`, [noJoinsDay]);
            await ds.query(`INSERT INTO guild_insights_daily VALUES (1, $1, 'joins', '', 1)`, [dayAt(-7)]);
            await ds.query(`SET TIME ZONE 'America/Los_Angeles'`);
            queries = 0;
            const daily = await Insights.daily("1", start, dayAt(-7));
            assert.equal(queries, 4);
            assert.equal(daily.get(start).retained[""], 1001);
            assert.equal(daily.get(end).retained[""], 1001);
            assert.equal(daily.get(emptyDay).retained[""], 0);
            assert.equal(daily.get(storedDay).retained[""], 77);
            assert.equal(daily.get(noJoinsDay).retained, undefined);
            assert.equal(daily.get(dayAt(-7)).retained, undefined);
            assert.deepEqual(normalize(daily.get(start).joins), { "": 1100 });
        });

        await t.test("stored retention for every eligible day avoids the fallback query", async () => {
            await ds.query(
                `INSERT INTO guild_insights_daily SELECT 1, $1::date + d * interval '1 day', 'retained', '', 9 FROM generate_series(0, 99) d
                WHERE NOT EXISTS (SELECT 1 FROM guild_insights_daily WHERE day = $1::date + d * interval '1 day' AND metric = 'retained')`,
                [start],
            );
            queries = 0;
            await Insights.daily("1", start, end);
            assert.equal(queries, 3);
        });
    } finally {
        if (ds?.isInitialized) await ds.destroy();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    }
});

test("insights completion and all metric batches commit atomically across failures and workers", { skip: !process.env.INSIGHTS_TEST_DATABASE, timeout: 30_000 }, async (t) => {
    const schema = `insights_atomic_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.INSIGHTS_TEST_DATABASE, max: 1 });
    let ds;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = new DataSource({
            type: "postgres",
            url: process.env.INSIGHTS_TEST_DATABASE,
            poolSize: 3,
            extra: { options: `-c search_path=${schema}` },
        });
        await ds.initialize();
        await ds.query(`CREATE TABLE guild_insights_daily (guild_id bigint, day date, metric varchar, key varchar, value bigint, PRIMARY KEY(guild_id,day,metric,key))`);
        await ds.query(`CREATE TABLE guild_insights_rollups (day date PRIMARY KEY)`);
        let interrupt = false;
        const Insights = loadInsights(
            (sql, parameters) => ds.query(sql, parameters),
            (fn) =>
                ds.transaction(async (manager) => {
                    const query = manager.query.bind(manager);
                    const executor = {
                        query: async (sql, parameters) => {
                            const result = await query(sql, parameters);
                            if (interrupt && sql.includes('INSERT INTO "guild_insights_daily"')) {
                                interrupt = false;
                                const [{ pid }] = await query("SELECT pg_backend_pid() AS pid");
                                assert.equal((await admin.query("SELECT pg_terminate_backend($1) AS stopped", [pid])).rows[0].stopped, true);
                            }
                            return result;
                        },
                    };
                    return fn(executor);
                }),
        );
        let computes = 0;
        Insights.computeRange = async () => {
            computes++;
            return new Map([
                [
                    "1",
                    {
                        messages: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`k${i}`, i + 1])),
                    },
                ],
            ]);
        };
        Insights.membership = async () => new Map([["1", 8]]);
        Insights.retained = async () => new Map([["1", 2]]);
        await ds.query(`INSERT INTO guild_insights_daily VALUES (1,'2026-09-01','messages','k0',7)`);
        await ds.query(
            `CREATE FUNCTION refuse_last_metric() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'k5000' THEN RAISE EXCEPTION 'injected last batch failure'; END IF; RETURN NEW; END $$`,
        );
        await ds.query(`CREATE TRIGGER refuse_last_metric BEFORE INSERT ON guild_insights_daily FOR EACH ROW EXECUTE FUNCTION refuse_last_metric()`);
        await t.test("failure in a later batch restores old metrics and leaves no completion marker", async () => {
            await assert.rejects(Insights.rollup("2026-09-01"), /injected last batch failure/);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_rollups"))[0].count, 0);
            assert.deepEqual(await ds.query("SELECT value::int AS value FROM guild_insights_daily"), [{ value: 7 }]);
        });
        await ds.query("DROP TRIGGER refuse_last_metric ON guild_insights_daily");
        await t.test("retry commits every batch and completed days avoid recomputation", async () => {
            assert.equal(await Insights.rollup("2026-09-01"), true);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_daily WHERE day='2026-09-01'"))[0].count, 5002);
            assert.equal((await ds.query("SELECT value::int AS value FROM guild_insights_daily WHERE metric='retained'"))[0].value, 2);
            const before = computes;
            assert.equal(await Insights.rollup("2026-09-01"), false);
            assert.equal(computes, before);
        });
        await t.test("simultaneous workers commit one completion marker and one set of metrics", async () => {
            const results = await Promise.all([Insights.rollup("2026-09-02"), Insights.rollup("2026-09-02")]);
            assert.deepEqual(results.sort(), [false, true]);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_rollups WHERE day='2026-09-02'"))[0].count, 1);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_daily WHERE day='2026-09-02'"))[0].count, 5002);
        });
        await t.test("connection interruption rolls back completion and permits recovery", async () => {
            interrupt = true;
            await assert.rejects(Insights.rollup("2026-09-03"));
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_rollups WHERE day='2026-09-03'"))[0].count, 0);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_daily WHERE day='2026-09-03'"))[0].count, 0);
            assert.equal(await Insights.rollup("2026-09-03"), true);
        });
    } finally {
        if (ds?.isInitialized) await ds.destroy();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    }
});

test("real insights queries preserve date boundaries, guild scope and incremental counters", { skip: !process.env.INSIGHTS_TEST_DATABASE, timeout: 30_000 }, async (t) => {
    const schema = `insights_inputs_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.INSIGHTS_TEST_DATABASE, max: 1 });
    let ds;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = new DataSource({
            type: "postgres",
            url: process.env.INSIGHTS_TEST_DATABASE,
            poolSize: 1,
            extra: { options: `-c search_path=${schema}` },
        });
        await ds.initialize();
        await ds.query("CREATE TABLE members (guild_id bigint,id bigint,joined_at timestamp,join_source_type int,source_invite_code varchar)");
        await ds.query("CREATE TABLE messages (id bigint,guild_id bigint,channel_id bigint,author_id bigint)");
        await ds.query("CREATE TABLE guild_insights_activity (guild_id bigint,day date,channel_id bigint,user_id bigint,kinds int)");
        await ds.query("CREATE TABLE guild_insights_daily (guild_id bigint,day date,metric varchar,key varchar,value bigint,PRIMARY KEY(guild_id,day,metric,key))");
        await ds.query(`INSERT INTO members VALUES
            (1,1,'2026-09-10 00:00',1,'a'),(1,2,'2026-09-09 23:59',0,NULL),(1,3,'2026-09-10 06:00',2,'b'),
            (1,4,'2026-09-10 07:00',0,NULL),(1,5,'2026-09-11 00:00',1,'a'),(1,6,'2026-09-10 23:59',1,'a'),(2,1,'2026-09-10 01:00',9,'other')`);
        await ds.query(`INSERT INTO guild_insights_activity VALUES
            (1,'2026-09-10',10,1,3),(1,'2026-09-10',10,4,1),(1,'2026-09-10',11,1,1),(1,'2026-09-10',11,3,3),
            (1,'2026-09-09',10,99,3),(1,'2026-09-11',10,98,3),(2,'2026-09-10',20,1,3)`);
        const start = BigInt(Date.parse("2026-09-10T00:00:00Z") - 1420070400000) << 22n;
        const end = BigInt(Date.parse("2026-09-11T00:00:00Z") - 1420070400000) << 22n;
        await ds.query(
            `INSERT INTO messages VALUES ($1,1,10,1),($2,1,10,1),($3,1,11,2),($4,1,11,3),($5,NULL,30,7),($6,1,10,99),($7,1,10,98),($8,2,20,1)`,
            [start, start + 1n, start + 2n, start + 3n, start + 4n, start - 1n, end, start + 5n].map(String),
        );
        let queries = 0;
        const Insights = loadInsights(async (sql, parameters) => {
            queries++;
            return ds.query(sql, parameters);
        });
        let computed;
        await t.test("half-open UTC boundaries and guild filtering exclude adjacent days and private messages", async () => {
            for (const timezone of ["UTC", "America/Los_Angeles"]) {
                await ds.query(`SET TIME ZONE '${timezone}'`);
                queries = 0;
                computed = await Insights.computeRange("2026-09-10", "2026-09-11", "1");
                assert.equal(queries, 3);
                assert.deepEqual([...computed.keys()], ["1"]);
                const metrics = computed.get("1");
                assert.deepEqual(normalize(metrics.messages), { "": 4, 10: 2, 11: 2 });
                assert.deepEqual(normalize(metrics.visitors), { "": 4, 10: 2, 11: 3 });
                assert.deepEqual(normalize(metrics.communicators), { "": 3, 10: 1, 11: 2 });
                assert.deepEqual(normalize(metrics.voice_users), { "": 2, 10: 1, 11: 1 });
                assert.deepEqual(normalize(metrics.new_communicators), { "": 2 });
                assert.deepEqual(normalize(metrics.joins), { "": 4 });
                assert.deepEqual(normalize(metrics.joins_source), { 0: 1, 1: 2, 2: 1 });
                assert.deepEqual(normalize(metrics.joins_invite), { a: 2, b: 1 });
            }
        });
        await t.test("all-guild aggregation preserves independent metrics for overlapping user IDs", async () => {
            const all = await Insights.computeRange("2026-09-10", "2026-09-11");
            assert.deepEqual(normalize(all.get("1")), normalize(computed.get("1")));
            assert.equal(all.get("2").messages[""], 1);
            assert.equal(all.get("2").visitors[""], 1);
            assert.equal(all.get("2").new_communicators[""], 1);
            assert.deepEqual(normalize(all.get("2").joins_source), { 9: 1 });
        });
        await t.test("repeated snapshot writes retain incremental joins and unrelated counters without summing snapshots", async () => {
            await Insights.increment("1", [
                ["joins", "", 5, "2026-09-10"],
                ["leaves", "0", 3, "2026-09-10"],
                ["messages", "", 7, "2026-09-10"],
            ]);
            const rows = [];
            for (const [metric, keys] of Object.entries(computed.get("1")))
                for (const [key, value] of Object.entries(keys)) rows.push({ guild_id: "1", day: "2026-09-10", metric, key, value });
            await Insights.write(rows);
            await Insights.write(rows);
            const stored = await ds.query("SELECT metric,key,value::int AS value FROM guild_insights_daily WHERE guild_id=1 AND day='2026-09-10'");
            const value = (metric, key = "") => stored.find((row) => row.metric === metric && row.key === key).value;
            assert.equal(value("joins"), 5);
            assert.equal(value("leaves", "0"), 3);
            assert.equal(value("messages"), 4);
            assert.equal(value("visitors"), 4);
        });
    } finally {
        if (ds?.isInitialized) await ds.destroy();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    }
});

test("slow insights reports coalesce beyond the TTL and cache time starts after completion", async () => {
    class Clock extends Date {
        static at = Date.parse("2026-10-07T12:00:00Z");
        static now() {
            return Clock.at;
        }
    }
    const Insights = loadInsights(
        () => {
            throw new Error("unexpected query");
        },
        undefined,
        Clock,
    );
    let release;
    let builds = 0;
    Insights.buildReport = () => {
        builds++;
        return new Promise((resolve) => {
            release = resolve;
        });
    };
    const first = Insights.report("1", null, null, 1);
    Clock.at += 35_000;
    assert.equal(Insights.report("1", null, null, 1), first);
    assert.equal(builds, 1);
    release([]);
    await first;
    Clock.at += 29_999;
    assert.equal(Insights.report("1", null, null, 1), first);
    Clock.at += 2;
    const next = Insights.report("1", null, null, 1);
    assert.notEqual(next, first);
    assert.equal(builds, 2);
    release([]);
    await next;
});

test("insights cache bounds pending work and retries failures", async () => {
    const Insights = loadInsights(() => {
        throw new Error("unexpected query");
    });
    const releases = [];
    const failures = [];
    let builds = 0;
    Insights.buildReport = () => {
        builds++;
        return new Promise((resolve, reject) => {
            releases.push(resolve);
            failures.push(reject);
        });
    };
    const pending = Array.from({ length: 8 }, (_, i) => Insights.report(String(i), null, null, 1));
    assert.equal(Insights.report("0", null, null, 1), pending[0]);
    assert.throws(
        () => Insights.report("8", null, null, 1),
        (error) => error.status === 503,
    );
    assert.equal(builds, 8);
    releases[0]([]);
    await pending[0];
    const replacement = Insights.report("8", null, null, 1);
    assert.equal(builds, 9);
    assert.equal(Insights.report("1", null, null, 1), pending[1]);
    failures[1](new Error("injected report failure"));
    await assert.rejects(pending[1], /injected report failure/);
    const retry = Insights.report("1", null, null, 1);
    assert.equal(builds, 10);
    for (const release of releases) release([]);
    await Promise.all([...pending.filter((_, i) => i !== 1), replacement, retry]);
});

test("insights report results evict the oldest completed entry at the cache bound", async () => {
    const Insights = loadInsights(() => {
        throw new Error("unexpected query");
    });
    let builds = 0;
    Insights.buildReport = async () => [{ sequence: ++builds }];
    const first = Insights.report("0", null, null, 1);
    await first;
    for (let i = 1; i < 128; i++) await Insights.report(String(i), null, null, 1);
    assert.equal(Insights.report("0", null, null, 1), first);
    const newest = Insights.report("128", null, null, 1);
    await newest;
    assert.equal(Insights.report("128", null, null, 1), newest);
    const rebuilt = Insights.report("0", null, null, 1);
    assert.notEqual(rebuilt, first);
    await rebuilt;
    assert.equal(builds, 130);
});

test("voice insight inputs persist combined activity flags and split time at UTC midnight", { skip: !process.env.INSIGHTS_TEST_DATABASE, timeout: 30_000 }, async (t) => {
    class Clock extends Date {
        static now() {
            return Date.parse("2026-10-07T00:00:05Z");
        }
    }
    const schema = `insights_voice_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: process.env.INSIGHTS_TEST_DATABASE, max: 1 });
    let ds;
    try {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = new DataSource({
            type: "postgres",
            url: process.env.INSIGHTS_TEST_DATABASE,
            poolSize: 1,
            extra: { options: `-c search_path=${schema}` },
        });
        await ds.initialize();
        await ds.query("CREATE TABLE channels (id bigint PRIMARY KEY,guild_id bigint)");
        await ds.query("INSERT INTO channels VALUES (10,1),(20,2),(30,NULL)");
        await ds.query("CREATE TABLE guild_insights_activity (guild_id bigint,day date,channel_id bigint,user_id bigint,kinds int,PRIMARY KEY(guild_id,day,channel_id,user_id))");
        await ds.query("CREATE TABLE guild_insights_daily (guild_id bigint,day date,metric varchar,key varchar,value bigint,PRIMARY KEY(guild_id,day,metric,key))");
        const writes = [];
        const Insights = loadInsights(
            (sql, parameters) => {
                const write = ds.query(sql, parameters);
                writes.push(write);
                return write;
            },
            undefined,
            Clock,
        );
        await t.test("repeated visits combine with voice flags on one channel-user-day row", async () => {
            await Insights.markActivity("10", "1", 1);
            Insights.voiceJoined("1", "10", "1");
            await Promise.all(writes);
            await Insights.markActivity("10", "1", 1);
            assert.deepEqual(await ds.query("SELECT guild_id::text,channel_id::text,user_id::text,kinds,to_char(day,'YYYY-MM-DD') AS day FROM guild_insights_activity"), [
                { guild_id: "1", channel_id: "10", user_id: "1", kinds: 3, day: "2026-10-07" },
            ]);
            await Insights.markActivity("30", "1", 3);
            await Insights.markActivity("999", "1", 3);
            const before = writes.length;
            Insights.voiceJoined(null, "30", "1");
            assert.equal(writes.length, before);
            assert.equal((await ds.query("SELECT count(*)::int AS count FROM guild_insights_activity"))[0].count, 1);
        });
        await t.test("a midnight crossing persists seconds for both days and both scopes", async () => {
            Insights.voiceLeft("1", "10", Date.parse("2026-10-06T23:59:55Z") / 1000);
            await Promise.all(writes);
            assert.deepEqual(await ds.query("SELECT guild_id::text,to_char(day,'YYYY-MM-DD') AS day,key,value::int AS value FROM guild_insights_daily ORDER BY day,key"), [
                { guild_id: "1", day: "2026-10-06", key: "", value: 5 },
                { guild_id: "1", day: "2026-10-06", key: "10", value: 5 },
                { guild_id: "1", day: "2026-10-07", key: "", value: 5 },
                { guild_id: "1", day: "2026-10-07", key: "10", value: 5 },
            ]);
        });
        await t.test("private channels and missing or future connection times add no counters", async () => {
            const before = writes.length;
            Insights.voiceLeft(null, "30", Date.parse("2026-10-06T23:59:55Z") / 1000);
            Insights.voiceLeft("1", "10", null);
            Insights.voiceLeft("1", "10", Clock.now() / 1000 + 1);
            Insights.voiceLeft("1", "10", NaN);
            assert.equal(writes.length, before);
        });
    } finally {
        if (ds?.isInitialized) await ds.destroy();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.end();
    }
});

test("insights rollups share pending work and allow retry after failure", async () => {
    let reject;
    let scans = 0;
    const api = loadInsights(() => {
        scans++;
        return new Promise((resolve, fail) => {
            reject = fail;
        });
    });
    const first = api.rollupPending();
    assert.equal(api.rollupPending(), first);
    assert.equal(scans, 1);
    reject(new Error("fixture scan refused"));
    await assert.rejects(first, /fixture scan refused/);
    const second = api.rollupPending();
    assert.notEqual(first, second);
    assert.equal(scans, 2);
    reject(new Error("fixture retry refused"));
    await assert.rejects(second, /fixture retry refused/);
});

test("insights stopping cancels timers, drains active work and leaves later days for restart", async () => {
    const lifecycle = { eventEmitter: new (require("node:events").EventEmitter)() };
    const scheduled = [];
    const cleared = [];
    const timers = {
        setTimeout: (run) => {
            const timer = {
                run,
                unref() {
                    return this;
                },
            };
            scheduled.push(timer);
            return timer;
        },
        setInterval: (run) => {
            const timer = {
                run,
                unref() {
                    return this;
                },
            };
            scheduled.push(timer);
            return timer;
        },
        clearTimeout: (timer) => cleared.push(timer),
        clearInterval: (timer) => cleared.push(timer),
    };
    const sql = [];
    const api = loadInsights(
        async (query) => {
            sql.push(query);
            return [];
        },
        undefined,
        Date,
        lifecycle,
        timers,
    );
    let finishDay;
    let finishReport;
    let days = 0;
    api.rollup = async () => {
        days++;
        await new Promise((resolve) => {
            finishDay = resolve;
        });
        return true;
    };
    api.buildReport = () =>
        new Promise((resolve) => {
            finishReport = resolve;
        });
    const timer = api.startRollups();
    assert.equal(api.startRollups(), timer);
    assert.equal(scheduled.length, 2);
    assert.equal(lifecycle.eventEmitter.listenerCount("stopping"), 1);
    const rolling = api.rollupPending();
    const reporting = api.report("1", null, null, 1);
    await new Promise(setImmediate);
    assert.equal(days, 1);
    let drained = false;
    const stopped = lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => {
            drained = true;
        });
    assert.deepEqual(cleared, scheduled);
    assert.throws(
        () => api.report("2", null, null, 1),
        (error) => error.status === 503,
    );
    scheduled.forEach(({ run }) => run());
    finishDay();
    assert.equal(await rolling, 1);
    await new Promise(setImmediate);
    assert.equal(drained, false);
    finishReport([]);
    await reporting;
    await stopped;
    assert.equal(days, 1);
    assert.equal(sql.length, 2);
    assert.equal(await api.rollupPending(), 0);
    assert.equal(sql.length, 2);
    assert.equal(api.startRollups(), timer);
});
