const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

function load(filename, imports) {
    const module = { exports: {} };
    const lifecycle = { eventEmitter: new EventEmitter() };
    const timers = [];
    const cleared = [];
    const errors = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            process: { env: {} },
            console: { log() {}, error: (...args) => errors.push(args) },
            setInterval: (run, delay) => {
                const timer = {
                    run,
                    delay,
                    unreferenced: false,
                    unref() {
                        this.unreferenced = true;
                        return this;
                    },
                };
                timers.push(timer);
                return timer;
            },
            clearInterval: (timer) => cleared.push(timer),
            require: (name) => {
                if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
                if (name.endsWith("/ProcessLifecycle")) return { ProcessLifecycle: lifecycle };
                if (Object.hasOwn(imports, name)) return imports[name];
                if (name.startsWith("node:")) return require(name);
                throw Error(name);
            },
        },
    );
    return { api: module.exports, lifecycle, timers, cleared, errors };
}
function events(find) {
    return load("src/database/voice/ScheduledEvents.ts", {
        typeorm: { LessThanOrEqual: (value) => value },
        "@spacebar/util/util": {},
        "../entities/GuildScheduledEvent": {
            GuildScheduledEvent: { find },
            GuildScheduledEventEntityType: { EXTERNAL: 3 },
            GuildScheduledEventStatus: { SCHEDULED: 1, ACTIVE: 2, COMPLETED: 3 },
        },
    });
}

test("scheduled-event shutdown drains the current transition and leaves later events pending", async () => {
    let scans = 0;
    const h = events(async () => {
        scans++;
        return [{ id: "1" }, { id: "2" }];
    });
    const api = h.api.ScheduledEvents;
    let finish;
    const transitions = [];
    api.setStatus = (event, status) => {
        transitions.push([event.id, status]);
        return new Promise((resolve) => {
            finish = resolve;
        });
    };
    api.startSweeper();
    api.startSweeper();
    const pending = api.sweep();
    assert.equal(api.sweep(), pending);
    await new Promise(setImmediate);
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
    await api.sweep();
    assert.equal(scans, 1);
    assert.deepEqual(transitions, [["1", 2]]);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].unreferenced, true);
    assert.deepEqual(h.cleared, h.timers);
    assert.equal(h.errors.length, 0);
});

test("scheduled-event failed scans release their pending promise for retry", async () => {
    let refused = true;
    let scans = 0;
    const h = events(async () => {
        scans++;
        if (refused) throw new Error("synthetic scan refused");
        return [];
    });
    const first = h.api.ScheduledEvents.sweep();
    assert.equal(h.api.ScheduledEvents.sweep(), first);
    await assert.rejects(first, /synthetic scan refused/);
    refused = false;
    await h.api.ScheduledEvents.sweep();
    assert.equal(scans, 3);
});

function announcements(query, send = async () => ({ id: "message", channel_id: "channel" })) {
    const committed = [];
    const pulses = [];
    const Announcement = {
        findOne: async () => ({
            id: "1",
            durable: true,
            attachment_count: 0,
            body: "synthetic announcement",
        }),
    };
    const AnnouncementDelivery = { update: async (where, value) => pulses.push({ where, value }) };
    const AnnouncementMessage = {};
    const database = {
        query,
        transaction: async (run) =>
            run({
                getRepository: (entity) => {
                    if (entity === Announcement) return { findOne: Announcement.findOne };
                    if (entity === AnnouncementMessage) return { upsert: async () => {} };
                    if (entity === AnnouncementDelivery) return { update: async (where, value) => committed.push({ where, value }) };
                    throw Error("unexpected fixture entity");
                },
            }),
    };
    const h = load("src/api/util/utility/announcementDelivery.ts", {
        "node:fs": {
            constants: {},
            promises: {
                open: async () => {
                    const error = new Error("synthetic spool absent");
                    error.code = "ENOENT";
                    throw error;
                },
            },
        },
        "@spacebar/database": {
            Announcement,
            AnnouncementDelivery,
            AnnouncementMessage,
            getDatabase: () => database,
            User: { findOne: async () => ({ id: "recipient" }) },
        },
        "@spacebar/util": { Snowflake: { generate: () => "synthetic-message" } },
        "./systemEncryption": { SystemRecipientNotReady: class extends Error {} },
        "./systemAccounts": { sendSystemDM: send },
        "./announcements": {},
    });
    return { ...h, committed, pulses };
}

test("announcement shutdown drains its active four-recipient batch and keeps lease heartbeats until completion", async () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({
        announcement_id: "1",
        user_id: String(index),
    }));
    let scans = 0;
    let claims = 0;
    let finish;
    const gate = new Promise((resolve) => {
        finish = resolve;
    });
    const h = announcements(
        async (sql, parameters) => {
            if (sql.startsWith("SELECT d.*")) {
                scans++;
                return rows;
            }
            claims++;
            return [
                {
                    announcement_id: parameters[0],
                    user_id: parameters[1],
                    message_id: parameters[2],
                    lease_token: parameters[3],
                    attempts: 1,
                },
            ];
        },
        async () => {
            await gate;
            return { id: "message", channel_id: "channel" };
        },
    );
    h.api.startAnnouncementDeliveryWorker();
    h.api.startAnnouncementDeliveryWorker();
    const pending = h.api.runAnnouncementDeliveries();
    assert.equal(h.api.runAnnouncementDeliveries(), pending);
    await new Promise(setImmediate);
    assert.equal(claims, 4);
    let drained = false;
    const stop = h.lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => {
            drained = true;
        });
    assert.deepEqual(h.cleared, [h.timers[0]]);
    h.timers[0].run();
    h.timers.slice(1).forEach((timer) => timer.run());
    await Promise.resolve();
    assert.equal(drained, false);
    assert.equal(h.pulses.length, 4);
    finish();
    await pending;
    await stop;
    await h.api.runAnnouncementDeliveries();
    assert.equal(scans, 1);
    assert.equal(claims, 4);
    assert.equal(h.committed.length, 4);
    assert.ok(h.committed.every(({ value }) => value.status === "delivered"));
    assert.equal(h.timers.length, 5);
    assert.ok(h.timers.every((timer) => timer.unreferenced));
    assert.equal(h.cleared.length, 5);
    assert.equal(h.errors.length, 0);
});

test("announcement failed scans can retry without leaving the worker marked active", async () => {
    let refused = true;
    let scans = 0;
    const h = announcements(async () => {
        scans++;
        if (refused) throw new Error("synthetic queue refused");
        return [];
    });
    const first = h.api.runAnnouncementDeliveries();
    assert.equal(h.api.runAnnouncementDeliveries(), first);
    await assert.rejects(first, /synthetic queue refused/);
    refused = false;
    await h.api.runAnnouncementDeliveries();
    assert.equal(scans, 2);
});
