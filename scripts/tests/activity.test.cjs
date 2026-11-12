const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const ts = require("typescript");
const definitions = JSON.parse(fs.readFileSync("assets/milestones.json", "utf8"));

function load(overrides = {}) {
    const result = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/util/utility/activity.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        {
            module: result,
            exports: result.exports,
            Buffer,
            process,
            console,
            Date: overrides.Date ?? Date,
            require(name) {
                if (name === "./milestones") return { milestones: definitions };
                if (name === "typeorm") return { MoreThan: (value) => value, Not: (value) => value };
                if (name === "@spacebar/database") return overrides.database ?? {};
                if (name === "@spacebar/database/Sql") return { sqlReturning: (value) => value };
                if (name === "@spacebar/util") return { emitEvent: async () => {} };
                if (name.endsWith("/ProcessLifecycle")) return { ProcessLifecycle: { eventEmitter: new EventEmitter() } };
                if (name === "./games") return { DetectableGames: { load: async () => ({ byId: new Map([["private-game", {}]]) }) } };
                if (name === "node:fs/promises") return { readFile: async () => Buffer.alloc(32, 9) };
                return require(name);
            },
        },
    );
    return result.exports;
}

const { advanceActivity, MAX_ACTIVITY_GAP } = load();

test("one active hour unlocks the first game and streaming tiers with server award dates", () => {
    let progress;
    for (let minute = 1; minute <= 60; minute++) {
        progress = advanceActivity(progress, { at: (minute - 1) * 60000, playing: true, streaming: true }, { at: minute * 60000, playing: true, streaming: true }, ["hash"]);
    }
    assert.equal(progress.played_ms, 3600000);
    assert.equal(progress.streamed_ms, 3600000);
    assert.equal(progress.games.length, 1);
    assert.equal(progress.awards["20:1"], "1970-01-01T01:00:00.000Z");
    assert.equal(progress.awards["19:1"], "1970-01-01T01:00:00.000Z");
});

test("fresh processes, stale heartbeats, paused streams and backwards clocks cannot manufacture hours", () => {
    const start = { played_ms: 1000, streamed_ms: 1000, games: [], last_credit: 10, awards: {} };
    for (const [previous, current] of [
        [undefined, { at: 10000000, playing: true, streaming: true }],
        [
            { at: 10, playing: true, streaming: true },
            { at: MAX_ACTIVITY_GAP + 11, playing: true, streaming: true },
        ],
        [
            { at: 100, playing: true, streaming: true },
            { at: 99, playing: true, streaming: true },
        ],
        [
            { at: 10, playing: false, streaming: false },
            { at: 1000, playing: false, streaming: false },
        ],
    ]) {
        const next = advanceActivity(start, previous, current, []);
        assert.equal(next.played_ms, 1000);
        assert.equal(next.streamed_ms, 1000);
    }
});

test("overlapping account sessions count each wall-clock interval once", () => {
    const previous = { at: 1000, playing: true, streaming: false };
    const current = { at: 61000, playing: true, streaming: false };
    const once = advanceActivity(undefined, previous, current, ["one", "one"]);
    const twice = advanceActivity(once, previous, current, ["one", "two"]);
    assert.equal(twice.played_ms, 60000);
    assert.equal(twice.streamed_ms, 0);
    assert.equal(twice.games.length, 2);
    assert.ok(twice.awards["21:2"]);
});

test("activity storage stops growing once badge requirements are complete", () => {
    const next = advanceActivity(
        { played_ms: 5000 * 3600000, streamed_ms: 5000 * 3600000, games: [], last_credit: 0, awards: {} },
        { at: 0, playing: true, streaming: true },
        { at: 60000, playing: true, streaming: true },
        Array.from({ length: 200 }, (_, index) => String(index)),
    );
    assert.equal(next.played_ms, 5000 * 3600000);
    assert.equal(next.streamed_ms, 5000 * 3600000);
    assert.equal(next.games.length, 100);
});

test("SQLite persistence deduplicates workers, hashes game identities and preserves unrelated preferences", async () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, account_preferences TEXT)");
    db.query("INSERT INTO users VALUES (?, ?)").run("player", JSON.stringify({ badge_settings: { hidden_badges: ["42"] } }));
    let now = 0;
    class Clock extends Date {
        static now() {
            return now;
        }
    }
    const database = {
        Session: { find: async () => [{ activities: [{ type: 0, application_id: "private-game" }] }] },
        Stream: { find: async () => [] },
        GoLiveStreams: { isPaused: () => false, viewers: async () => [] },
        User: {
            findOne: async () => ({
                id: "player",
                bot: false,
                federated_instance: null,
                account_preferences: JSON.parse(db.query("SELECT account_preferences FROM users WHERE id = ?").get("player").account_preferences),
            }),
            getRepository: () => ({ manager: { connection: { options: { type: "sqlite" } } } }),
            query: async (sql, params) => db.query(sql).all(...params),
            getPublicUser: async () => ({ id: "player" }),
        },
    };
    const first = load({ database, Date: Clock });
    const second = load({ database, Date: Clock });
    await first.recordActivity("player");
    await second.recordActivity("player");
    now = 60000;
    await Promise.all([first.recordActivity("player"), second.recordActivity("player")]);
    const preferences = JSON.parse(db.query("SELECT account_preferences FROM users WHERE id = ?").get("player").account_preferences);
    assert.equal(preferences.activity_progress.played_ms, 60000);
    assert.equal(preferences.activity_progress.games.length, 1);
    assert.match(preferences.activity_progress.games[0], /^[0-9a-f]{32}$/);
    assert.doesNotMatch(JSON.stringify(preferences), /private-game/);
    assert.deepEqual(preferences.badge_settings.hidden_badges, ["42"]);
    db.close();
});

test("PostgreSQL compare-and-swap preserves one hour across overlapping workers", { skip: !process.env.ACTIVITY_POSTGRES_URL }, async () => {
    const { Client } = require("pg");
    const client = new Client({ connectionString: process.env.ACTIVITY_POSTGRES_URL });
    await client.connect();
    try {
        await client.query("CREATE TEMP TABLE users (id text PRIMARY KEY, account_preferences jsonb)");
        await client.query("INSERT INTO users VALUES ($1, $2)", ["player", JSON.stringify({ badge_settings: { hidden_badges: ["42"] } })]);
        let now = 0;
        class Clock extends Date {
            static now() {
                return now;
            }
        }
        const database = {
            Session: { find: async () => [{ activities: [{ type: 0, application_id: "private-game" }] }] },
            Stream: { find: async () => [] },
            GoLiveStreams: { isPaused: () => false, viewers: async () => [] },
            User: {
                findOne: async () => ({
                    id: "player",
                    bot: false,
                    federated_instance: null,
                    account_preferences: (await client.query("SELECT account_preferences FROM users WHERE id = $1", ["player"])).rows[0].account_preferences,
                }),
                getRepository: () => ({ manager: { connection: { options: { type: "postgres" } } } }),
                query: async (sql, params) => (await client.query(sql, params)).rows,
                getPublicUser: async () => ({ id: "player" }),
            },
        };
        const first = load({ database, Date: Clock });
        const second = load({ database, Date: Clock });
        await Promise.all([first.recordActivity("player"), second.recordActivity("player")]);
        for (let minute = 1; minute <= 60; minute++) {
            now = minute * 60000;
            await Promise.all([first.recordActivity("player"), second.recordActivity("player")]);
        }
        const preferences = (await client.query("SELECT account_preferences FROM users WHERE id = $1", ["player"])).rows[0].account_preferences;
        assert.equal(preferences.activity_progress.played_ms, 3600000);
        assert.equal(preferences.activity_progress.games.length, 1);
        assert.ok(preferences.activity_progress.awards["20:1"]);
        assert.deepEqual(preferences.badge_settings.hidden_badges, ["42"]);
    } finally {
        await client.end();
    }
});

test("streaming credit requires the owner media session, an actual viewer and an unpaused stream", async () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, account_preferences TEXT)");
    db.query("INSERT INTO users VALUES (?, ?)").run("streamer", "{}");
    let now = 0,
        paused = false,
        viewers = [],
        owner = true;
    class Clock extends Date {
        static now() {
            return now;
        }
    }
    const database = {
        Session: { find: async () => [] },
        Stream: { find: async () => [{ id: "stream" }] },
        StreamSession: { exists: async ({ where }) => where.used === true && where.user_id === "streamer" && owner },
        GoLiveStreams: { isPaused: () => paused, viewers: async () => viewers },
        User: {
            findOne: async () => ({
                id: "streamer",
                account_preferences: JSON.parse(db.query("SELECT account_preferences FROM users WHERE id = ?").get("streamer").account_preferences),
            }),
            getRepository: () => ({ manager: { connection: { options: { type: "sqlite" } } } }),
            query: async (sql, params) => db.query(sql).all(...params),
            getPublicUser: async () => ({ id: "streamer" }),
        },
    };
    const activity = load({ database, Date: Clock });
    await activity.recordActivity("streamer");
    now = 60000;
    viewers = ["viewer"];
    await activity.recordActivity("streamer");
    now = 120000;
    await activity.recordActivity("streamer");
    paused = true;
    await activity.recordActivity("streamer");
    now = 180000;
    await activity.recordActivity("streamer");
    paused = false;
    viewers = [];
    await activity.recordActivity("streamer");
    now = 240000;
    viewers = ["viewer"];
    await activity.recordActivity("streamer");
    now = 300000;
    owner = false;
    await activity.recordActivity("streamer");
    now = 360000;
    await activity.recordActivity("streamer");
    const progress = JSON.parse(db.query("SELECT account_preferences FROM users WHERE id = ?").get("streamer").account_preferences).activity_progress;
    assert.equal(progress.streamed_ms, 120000);
    assert.equal(progress.played_ms, 0);
    db.close();
});
