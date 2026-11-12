const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

function harness(update = async () => {}, broadcast = async () => {}) {
    const module = { exports: {} };
    const lifecycle = { shutdownRequested: false, eventEmitter: new EventEmitter() };
    const timers = [];
    const writes = [];
    const events = [];
    const errors = [];
    let now = 100_000;
    class Clock extends Date {
        constructor(...args) {
            super(...(args.length ? args : [now]));
        }
        static now() {
            return now;
        }
    }
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/gateway/opcodes/PresenceUpdate.ts", "utf8") + "\nmodule.exports.fixture = { pendingPresences };", {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            Date: Clock,
            console: { error: (...args) => errors.push(args) },
            setTimeout: (run, delay) => {
                const timer = {
                    run,
                    delay,
                    cancelled: false,
                    unreferenced: false,
                    unref() {
                        this.unreferenced = true;
                        return this;
                    },
                };
                timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => {
                if (timer) timer.cancelled = true;
            },
            require: (name) => {
                if (name === "@spacebar/api/util/utility/activity") return { hasActivityWindow: () => false, recordActivity: async () => {} };
                if (name.endsWith("/ProcessLifecycle")) return { ProcessLifecycle: lifecycle };
                if (name === "@spacebar/database")
                    return {
                        Session: {
                            update: async (...args) => {
                                writes.push(args);
                                await update(...args);
                            },
                        },
                    };
                if (name === "@spacebar/util")
                    return {
                        sanitizeActivities: (activities) => activities,
                        broadcastPresence: async (id) => {
                            events.push(["presence", id]);
                            await broadcast(id);
                        },
                        emitSessionsReplace: async (id) => events.push(["sessions", id]),
                    };
                if (name === "./instanceOf") return { check() {} };
                if (name === "@spacebar/gateway" || name === "@spacebar/schemas") return {};
                throw Error(name);
            },
        },
    );
    const socket = {
        user_id: "owner",
        OPEN: 1,
        readyState: 1,
        session: {
            session_id: "auth",
            status: "online",
            activities: [],
            client_status: { web: "online" },
            client_info: { platform: "web" },
        },
    };
    return {
        api: module.exports,
        lifecycle,
        timers,
        writes,
        events,
        errors,
        socket,
        advance: (time) => {
            now += time;
        },
        change: (status = "idle", activities = []) => module.exports.onPresenceUpdate.call(socket, { d: { status, activities } }),
    };
}
const tick = () => new Promise(setImmediate);
const stop = async (h) => {
    for (const listener of h.lifecycle.eventEmitter.listeners("stopping")) await listener();
};

test("presence throttling retains five immediate updates and flushes the latest queued state once", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.change("online", [{ name: `activity-${i}` }]);
    assert.equal(h.writes.length, 5);
    await h.change("idle", [{ name: "queued" }]);
    await h.change("dnd", [{ name: "latest" }]);
    assert.equal(h.writes.length, 5);
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 20_000);
    assert.equal(h.timers[0].unreferenced, true);
    h.advance(20_000);
    h.timers[0].run();
    await tick();
    assert.equal(h.writes.length, 6);
    assert.equal(h.writes[5][1].status, "dnd");
    assert.equal(h.writes[5][1].activities[0].name, "latest");
    assert.equal(h.api.fixture.pendingPresences.size, 0);
    await stop(h);
});

test("shutdown cancels a queued presence update and prevents later state mutation or writes", async () => {
    const h = harness();
    h.socket.presenceHistory = [100_000, 100_000, 100_000, 100_000, 100_000];
    await h.change();
    await stop(h);
    assert.equal(h.timers[0].cancelled, true);
    assert.equal(h.socket.presenceTimer, undefined);
    assert.equal(h.api.fixture.pendingPresences.size, 0);
    h.timers[0].run();
    await h.change("dnd");
    await tick();
    assert.equal(h.socket.session.status, "idle");
    assert.equal(h.writes.length, 0);
    assert.equal(h.events.length, 0);
});

test("shutdown drains an admitted database update and its presence broadcast", async () => {
    let finishUpdate;
    let finishBroadcast;
    const h = harness(
        () =>
            new Promise((resolve) => {
                finishUpdate = resolve;
            }),
        () =>
            new Promise((resolve) => {
                finishBroadcast = resolve;
            }),
    );
    const work = h.change();
    let stopped = false;
    const stopping = stop(h).then(() => {
        stopped = true;
    });
    await tick();
    assert.equal(stopped, false);
    finishUpdate();
    await tick();
    assert.equal(stopped, false);
    assert.equal(h.events[0][0], "presence");
    finishBroadcast();
    await Promise.all([work, stopping]);
    assert.equal(h.events[1][0], "sessions");
});

test("socket cancellation releases its queued presence reference", async () => {
    const h = harness();
    h.socket.presenceHistory = [100_000, 100_000, 100_000, 100_000, 100_000];
    await h.change();
    h.api.cancelPendingPresence(h.socket);
    assert.equal(h.api.fixture.pendingPresences.size, 0);
    assert.equal(h.timers[0].cancelled, true);
    assert.equal(h.socket.presenceTimer, undefined);
    await stop(h);
});

test("a failed presence write releases active work so shutdown can finish", async () => {
    const h = harness(async () => {
        throw Error("owned write failure");
    });
    await assert.rejects(h.change(), /owned write failure/);
    await stop(h);
    assert.equal(h.events.length, 0);
});

test("a startup shutdown request rejects new presence work before stopping dispatch", async () => {
    const h = harness();
    h.lifecycle.shutdownRequested = true;
    await h.change();
    assert.equal(h.socket.session.status, "online");
    assert.equal(h.writes.length, 0);
    assert.equal(h.timers.length, 0);
});
