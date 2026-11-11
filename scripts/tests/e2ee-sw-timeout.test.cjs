const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (postMessage) => {
    const events = new Map();
    const timers = [];
    const ports = [];
    const module = { exports: {} };
    const bounded = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync("client/e2ee/src/boundedMap.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        module: bounded,
        exports: bounded.exports,
    });
    const source = ts.transpileModule(fs.readFileSync("client/e2ee/src/sw.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        require: (name) => (name === "./files" ? { FILE_PREFIX: "/e2ee/attachments/" } : bounded.exports),
        self: {
            location: { origin: "https://chat.test" },
            clients: {
                get: async () => ({ postMessage }),
                matchAll: async () => [{ postMessage }],
                claim: async () => {},
            },
            addEventListener: (name, listener) => events.set(name, listener),
        },
        MessageChannel: class {
            constructor() {
                this.port1 = {
                    closed: false,
                    close() {
                        this.closed = true;
                    },
                };
                this.port2 = {};
                ports.push(this.port1);
            }
        },
        setTimeout: (fn, ms) => {
            timers.push({ fn, ms });
            return timers.length;
        },
        clearTimeout: () => {},
        Request,
        Response,
        URL,
        console,
    });
    return { events, timers, ports };
};

test("a service-worker ask timeout closes every worker-side message port", async () => {
    const worker = load(() => {});
    let response;
    worker.events.get("fetch")({
        request: new Request("https://chat.test/e2ee/attachments/1/2/file.png"),
        clientId: "window",
        respondWith: (value) => {
            response = value;
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    worker.timers[0].fn();

    assert.equal((await response).status, 404);
    assert.equal((await response).headers.get("X-E2EE-Error"), "file-key-unavailable");
    assert.ok(worker.ports.length > 0);
    assert.ok(worker.ports.every((port) => port.closed));
});

test("a page that cannot receive an ask still closes its message port", async () => {
    const worker = load(() => {
        throw new Error("client is gone");
    });
    let response;
    worker.events.get("fetch")({
        request: new Request("https://chat.test/e2ee/attachments/1/2/file.png"),
        clientId: "window",
        respondWith: (value) => {
            response = value;
        },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((await response).status, 404);
    assert.ok(worker.ports.every((port) => port.closed));
});
