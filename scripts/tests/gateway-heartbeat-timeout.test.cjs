const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModule } = require("./helpers/route-harness.cjs");

function harness() {
    const timers = [];
    const module = loadModule(
        "src/gateway/util/Heartbeat.ts",
        { "./Constants": { CLOSECODES: { Session_timed_out: 4009 } } },
        {
            setTimeout: (fn, ms) => {
                const timer = { fn, ms, canceled: false };
                timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => {
                if (timer) timer.canceled = true;
            },
        },
    );
    return { ...module, timers };
}

test("the gateway advertises 30 seconds and allows three missed heartbeats", () => {
    const heartbeat = harness();
    assert.equal(heartbeat.HEARTBEAT_INTERVAL_MS, 30_000);
    assert.equal(heartbeat.HEARTBEAT_TIMEOUT_MS, 90_000);
    assert.equal(heartbeat.HEARTBEAT_TIMEOUT_MS, heartbeat.HEARTBEAT_INTERVAL_MS * 3);
});

test("a heartbeat schedules a 90 second close and replaces the previous timer", () => {
    const heartbeat = harness();
    const socket = { heartbeatTimeout: null, close: () => {} };
    heartbeat.setHeartbeat(socket);
    assert.equal(heartbeat.timers.length, 1);
    assert.equal(heartbeat.timers[0].ms, 90_000);

    const previous = heartbeat.timers[0];
    heartbeat.setHeartbeat(socket);
    assert.equal(previous.canceled, true);
    assert.equal(heartbeat.timers.length, 2);
    assert.equal(heartbeat.timers[1].ms, 90_000);
});

test("the timeout closes the session with code 4009", () => {
    const heartbeat = harness();
    let closed = null;
    const socket = { heartbeatTimeout: null, close: (code) => (closed = code) };
    heartbeat.setHeartbeat(socket);
    heartbeat.timers[0].fn();
    assert.equal(closed, 4009);
});
