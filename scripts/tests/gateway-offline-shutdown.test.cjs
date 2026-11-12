const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

function harness(find = async () => ({ last_seen: new Date(0) })) {
    const module = { exports: {} };
    const lifecycle = { state: "running", eventEmitter: new EventEmitter() };
    const timers = [];
    const updates = [];
    const connections = [];
    const errors = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/gateway/events/Close.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            console: { log() {}, error: (...args) => errors.push(args) },
            require: (name) => {
                if (name === "@spacebar/api/util/utility/activity") return { hasActivityWindow: () => false, recordActivity: async () => {} };
                if (name.endsWith("/ProcessLifecycle")) return { ProcessLifecycle: lifecycle };
                if (name === "../opcodes/PresenceUpdate")
                    return {
                        cancelPendingPresence: (socket) => {
                            socket.presenceTimer = undefined;
                        },
                    };
                if (name === "./Connection") return { openConnections: connections };
                if (name === "@spacebar/database")
                    return {
                        Session: { findOne: find, update: async (...args) => updates.push(args) },
                        VoiceState: { findOne: async () => null },
                    };
                if (name === "@spacebar/gateway/util") return { isFinalClose: (code) => code === 1000 || code === 1001, releaseDispatchBuffers() {} };
                if (name === "@spacebar/util") return { emitSessionsReplace: async () => {}, broadcastPresence: async () => {} };
                throw Error(name);
            },
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
        },
    );
    const socket = {
        user_id: "owner",
        session: { session_id: "auth" },
        session_id: "gateway",
        removeAllListeners() {},
    };
    return {
        close: (code = 1006) => module.exports.Close.call(socket, code, Buffer.from("")),
        lifecycle,
        timers,
        updates,
        connections,
        errors,
        socket,
    };
}
async function stop(h) {
    h.lifecycle.state = "stopping";
    for (const listener of h.lifecycle.eventEmitter.listeners("stopping")) await listener();
}

test("shutdown cancels deferred offline timers and waits for their database update", async () => {
    let finish;
    const h = harness(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    await h.close();
    assert.equal(h.timers[0].delay, 10000);
    assert.equal(h.timers[0].unreferenced, true);
    let done = false;
    const stopping = stop(h).then(() => {
        done = true;
    });
    await new Promise(setImmediate);
    assert.equal(done, false);
    assert.equal(h.timers[0].cancelled, true);
    finish({ last_seen: new Date(0) });
    await stopping;
    assert.equal(h.updates.length, 1);
    const closed = h.close();
    await new Promise(setImmediate);
    finish({ last_seen: new Date(0) });
    await closed;
    assert.equal(h.timers.length, 1);
});

test("shutdown leaves a reconnected authentication session online", async () => {
    const h = harness();
    await h.close();
    h.connections.push({ user_id: "owner", session: { session_id: "auth" } });
    await stop(h);
    assert.equal(h.updates.length, 0);
});

test("shutdown leaves a session with newer activity online", async () => {
    const h = harness(async () => ({ last_seen: new Date(Date.now() + 10000) }));
    await h.close();
    await stop(h);
    assert.equal(h.updates.length, 0);
});

test("shutdown drains already executing offline work and contains database errors", async () => {
    let fail;
    const h = harness(
        () =>
            new Promise((resolve, reject) => {
                fail = reject;
            }),
    );
    await h.close(1000);
    assert.equal(h.timers[0].delay, 0);
    const work = h.timers[0].run();
    let done = false;
    const stopping = stop(h).then(() => {
        done = true;
    });
    await new Promise(setImmediate);
    assert.equal(done, false);
    fail(Error("synthetic database failure"));
    await Promise.all([work, stopping]);
    assert.equal(h.errors.length, 1);
});
