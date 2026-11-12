const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function harness() {
    const updates = [];
    const broadcasts = [];
    const module = { exports: {} };
    const mocks = {
        "@spacebar/api/util/utility/activity": { hasActivityWindow: () => false, recordActivity: async () => {} },
        typeorm: {},
        "@spacebar/gateway": { OPCODES: { SetQoS: 40 } },
        "@spacebar/database": {
            Session: {
                update: async (where, values) => {
                    updates.push(values);
                },
            },
        },
        "@spacebar/util": {
            PRESENCE_STALE_AFTER_MS: 90_000,
            broadcastPresence: async (user_id) => {
                broadcasts.push(user_id);
            },
        },
        "../util/Heartbeat": { setHeartbeat() {} },
        "../util/Send": { Send: async () => {} },
    };
    const filename = path.join(__dirname, "../../src/gateway/opcodes/Heartbeat.ts");
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        { module, exports: module.exports, require: (name) => mocks[name], console },
        { filename },
    );
    return { updates, broadcasts, beat: (socket) => module.exports.onHeartbeat.call(socket, { op: 1 }) };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a heartbeat after the session went stale brings the presence back", async () => {
    const h = harness();
    const socket = {
        user_id: "1290000000000000001",
        lastSeenWrite: Date.now() - 120_000,
        session: { session_id: "s", status: "dnd", activities: [], client_status: { web: "dnd" }, last_seen: new Date(Date.now() - 120_000) },
    };
    await h.beat(socket);
    await settle();
    assert.equal(h.updates[0].status, "dnd", "the status the socket holds is written back");
    assert.deepEqual(h.broadcasts, ["1290000000000000001"]);
});

test("a heartbeat inside the presence window only records the time", async () => {
    const h = harness();
    const socket = {
        user_id: "1290000000000000001",
        lastSeenWrite: Date.now() - 61_000,
        session: { session_id: "s", status: "online", activities: [], client_status: { web: "online" }, last_seen: new Date() },
    };
    await h.beat(socket);
    await settle();
    assert.equal(h.updates[0].status, undefined);
    assert.equal(h.broadcasts.length, 0);
});
