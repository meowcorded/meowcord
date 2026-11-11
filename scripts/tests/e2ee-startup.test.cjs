const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compile = (file) =>
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
const network = (() => {
    const module = { exports: {} };
    vm.runInNewContext(compile("client/e2ee/src/network.ts"), { module, exports: module.exports, Error });
    return module.exports;
})();
const flush = async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
};
function channelHarness() {
    const module = { exports: {} };
    const timers = [];
    let now = 0;
    vm.runInNewContext(compile("client/e2ee/src/channelLoader.ts"), {
        module,
        exports: module.exports,
        Date: { now: () => now },
        setTimeout: (fn, ms) => {
            const timer = { fn, at: now + ms };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            timer.cancelled = true;
        },
    });
    return {
        create: module.exports.createChannelLoader,
        advance: async (ms) => {
            now += ms;
            for (const timer of timers)
                if (!timer.cancelled && timer.at <= now) {
                    timer.cancelled = true;
                    timer.fn();
                }
            await flush();
        },
    };
}
test("channel member UI coalesces refreshes and ignores out-of-order navigation results", async () => {
    const h = channelHarness();
    let current = "A";
    const calls = [],
        received = [];
    const a = deferred(),
        b = deferred();
    const load = h.create({
        current: () => current,
        load: (id) => {
            calls.push(id);
            return id === "A" ? a.promise : b.promise;
        },
        receive: (id, value) => received.push({ id, value }),
        retry() {},
    });
    for (let i = 0; i < 50; i++) load("A");
    await flush();
    assert.deepEqual(calls, ["A"]);
    current = "B";
    for (let i = 0; i < 50; i++) load("B");
    await flush();
    b.resolve("B members");
    await flush();
    a.resolve("A members");
    await flush();
    assert.deepEqual(calls, ["A", "B"]);
    assert.deepEqual(received, [{ id: "B", value: "B members" }]);
});
test("failed member requests retry after a bounded delay, and navigation cancels stale retry effects", async () => {
    const h = channelHarness();
    let current = "A",
        calls = 0,
        retries = 0;
    const load = h.create({
        current: () => current,
        load: async () => {
            calls++;
            throw new Error("offline");
        },
        receive() {},
        retry: () => {
            retries++;
            load(current);
        },
        retryMs: 5000,
    });
    load("A");
    await flush();
    for (let i = 0; i < 50; i++) load("A");
    await flush();
    assert.equal(calls, 1);
    await h.advance(4999);
    assert.equal(calls, 1);
    await h.advance(1);
    assert.equal(calls, 2);
    assert.equal(retries, 1);
    current = "B";
    await h.advance(5000);
    assert.equal(calls, 2);
    assert.equal(retries, 1);
});
function startupHarness({ token = "stored-token", initError = null } = {}) {
    const timers = [];
    let now = 100000;
    let initAttempts = 0;
    const module = { exports: {} };
    const worker = deferred();
    let requested;
    class Engine {
        constructor() {
            this.prekeys = [{ id: 1, publicKey: "test", keyPair: {} }];
            this.encryptedChannels = new Set();
            this.linked = true;
            this.locked = false;
        }
        async init(id) {
            if (initError && initAttempts++ === 0) throw initError;
            this.userId = id;
        }
        onUnlock() {}
        onWipe() {}
        onChange() {}
        invalidateAll() {
            this.invalidated = (this.invalidated ?? 0) + 1;
        }
        async refresh() {
            this.refreshed = (this.refreshed ?? 0) + 1;
        }
        isEncrypted() {
            return true;
        }
    }
    const crypto = {
        generateAgreementKey: async () => ({ publicKey: {}, privateKey: {} }),
        generateSigningKey: async () => ({ publicKey: {}, privateKey: {} }),
        exportPublic: async () => "test",
        hpkeSeal: async (_key, bytes) => ({ enc: "test", wrapped: bytes }),
        hpkeOpen: async (_pair, _enc, bytes) => bytes,
        aesEncrypt: async (_key, _iv, bytes) => bytes,
        aesDecrypt: async (_key, _iv, bytes) => bytes,
        sign: async () => "test",
        verify: async (_key, message) => message === "self-test",
    };
    const ui = { pause() {}, refresh() {}, fail() {}, unlockSnoozed: () => false };
    const listeners = {};
    const window = {
        addEventListener(type, listener) {
            (listeners[type] ??= []).push(listener);
        },
    };
    let retries = 0;
    const require = (name) => {
        if (name === "./attachments") return { createAttachments: () => ({ start() {}, ready: () => worker.promise }) };
        if (name === "./bytes")
            return {
                randomBytes: (n) => new Uint8Array(n).fill(1),
                toB64u: (bytes) => Buffer.from(bytes).toString("base64url"),
            };
        if (name === "./crypto") return crypto;
        if (name === "./engine") return { Engine };
        if (name === "./network") return network;
        if (name === "./hooks") return { createHooks: () => ({ retryAll: () => retries++ }) };
        if (name === "./link") return { createLink: () => ({ start() {}, stop() {}, outgoing: () => null }) };
        if (name === "./ui") return { createUi: () => ui };
        if (name === "./store") return { browserStorage: { getItem: (key) => (key === "token" && token ? JSON.stringify(token) : null) } };
        if (name === "./webpack") return { scan() {}, findStore: () => null };
        if (name === "./i18n") return { t: (s) => s };
        throw new Error(name);
    };
    const source =
        compile("client/e2ee/src/index.ts").replace(/tick\(\);\s*$/, "") +
        "\nexports.test={start,startWhenReady,ready,api,logout:()=>{loggedOut=true;},setGateway:(value)=>{targets.gateway=value;},initialized:()=>initialized,setHttp:(value)=>{http=value;},settleReady:()=>{Object.assign(installed,{http:true,dispatcher:true,gateway:true});tick();},engine:()=>engine};";
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        require,
        window,
        location: { protocol: "https:", host: "meowcord.example", pathname: "/channels/@me/123" },
        console,
        Date: class extends Date {
            static now() {
                return now;
            }
        },
        setTimeout: (fn, ms) => {
            const timer = { fn, ms, at: now + ms, done: false };
            timers.push(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            if (timer) timer.done = true;
        },
        Buffer,
        URL,
        AbortSignal,
    });
    module.exports.test.setHttp({
        get: async (opts) => {
            requested = opts;
            return { ok: true, status: 200, body: { ok: true } };
        },
    });
    return {
        api: module.exports.test,
        worker,
        engine: () => module.exports.test.engine(),
        retries: () => retries,
        fire: (type) => {
            for (const listener of listeners[type] ?? []) listener({});
        },
        requested: () => requested,
        advance: (ms) => {
            now += ms;
            for (const timer of timers) {
                if (timer.done || timer.at > now) continue;
                timer.done = true;
                timer.fn();
            }
        },
    };
}
test("text encryption settles without waiting for attachment worker control", async () => {
    const h = startupHarness();
    await h.api.start("123");
    assert.equal(h.api.initialized(), true);
    h.api.settleReady();
    assert.equal(await h.api.ready, true);
    h.worker.resolve(true);
    await flush();
});
test("startup retries a transient request failure without disabling encryption", async () => {
    const h = startupHarness({ initError: { status: 503 } });
    await h.api.start("123");
    assert.equal(h.api.initialized(), false);
    h.advance(5000);
    await flush();
    assert.equal(h.api.initialized(), true);
});

test("startup retries a transport failure without disabling encryption", async () => {
    const h = startupHarness({ initError: network.requestFailure(new TypeError("fetch failed")) });
    await h.api.start("123");
    assert.equal(h.api.initialized(), false);
    h.advance(5000);
    await flush();
    assert.equal(h.api.initialized(), true);
});

test("browser online recovery invalidates keys and retries decryption", async () => {
    const h = startupHarness();
    await h.api.start("123");
    h.api.settleReady();
    assert.equal(h.api.initialized(), true);

    h.fire("online");
    assert.equal(h.engine().invalidated, 1);
    assert.equal(h.retries(), 1);

    h.advance(500);
    await flush();
    assert.equal(h.engine().refreshed, 1);
});

test("startup does not retry a non-transient failure without a status", async () => {
    const h = startupHarness({ initError: new Error("broken self test") });
    await h.api.start("123");
    assert.equal(h.api.initialized(), false);
    h.advance(10_000);
    await flush();
    assert.equal(h.api.initialized(), false);
});

test("encryption HTTP calls carry a finite native timeout with no hidden retries", async () => {
    const h = startupHarness();
    const result = await h.api.api.request("get", "/users/@me/e2ee");
    assert.equal(result.ok, true);
    assert.ok(h.requested().timeout > 0 && h.requested().timeout <= 15000);
    assert.equal(h.requested().retries, 0);
});

test("authenticated REST bootstraps when the native gateway session predicate remains false", async () => {
    const h = startupHarness();
    const response = deferred();
    let calls = 0;
    h.api.setGateway({ getSocket: () => ({ isSessionEstablished: () => false }) });
    h.api.setHttp({
        get: async () => {
            calls++;
            return response.promise;
        },
    });
    for (let i = 0; i < 50; i++) h.api.startWhenReady();
    await flush();
    assert.equal(calls, 1);
    h.advance(15000);
    for (let i = 0; i < 50; i++) h.api.startWhenReady();
    await flush();
    assert.equal(calls, 1);
    response.resolve({ ok: true, status: 200, body: { id: "123" } });
    await flush();
    assert.equal(h.api.initialized(), true);
});

test("REST bootstrap without a gateway predicate rejects unauthenticated and malformed identities", async () => {
    for (const response of [
        { ok: false, status: 403, body: {} },
        { ok: false, status: 401, body: {} },
        { ok: true, status: 200, body: { id: "" } },
        { ok: true, status: 200, body: { id: "not-a-snowflake" } },
        { ok: true, status: 200, body: { id: 123 } },
        { ok: true, status: 200, body: {} },
    ]) {
        const h = startupHarness();
        h.api.setHttp({ get: async () => response });
        h.api.startWhenReady();
        await flush();
        assert.equal(h.api.initialized(), false);
    }
});

test("logout while authenticated bootstrap is pending prevents key initialization", async () => {
    const h = startupHarness();
    const response = deferred();
    h.api.setHttp({ get: async () => response.promise });
    h.api.startWhenReady();
    await flush();
    h.api.logout();
    response.resolve({ ok: true, status: 200, body: { id: "123" } });
    await flush();
    assert.equal(h.api.initialized(), false);
});

test("gateway-free authenticated bootstrap succeeds and failed probes remain bounded", async () => {
    const h = startupHarness();
    let calls = 0;
    h.api.setHttp({
        get: async () => {
            calls++;
            return calls === 1 ? { ok: false, status: 503, body: {} } : { ok: true, status: 200, body: { id: "123" } };
        },
    });
    h.api.startWhenReady();
    await flush();
    for (let i = 0; i < 50; i++) h.api.startWhenReady();
    await flush();
    assert.equal(calls, 1);
    h.advance(9999);
    h.api.startWhenReady();
    await flush();
    assert.equal(calls, 1);
    h.advance(1);
    h.api.startWhenReady();
    await flush();
    assert.equal(calls, 2);
    assert.equal(h.api.initialized(), true);
});

test("signed out pages never probe the current user", async () => {
    const h = startupHarness({ token: null });
    let calls = 0;
    h.api.setHttp({
        get: async () => {
            calls++;
            return { ok: false, status: 401, body: {} };
        },
    });
    for (let i = 0; i < 5; i++) {
        h.api.startWhenReady();
        await flush();
        h.advance(10000);
    }
    assert.equal(calls, 0);
    assert.equal(h.api.initialized(), false);
});

test("anonymous unauthorized probes do not permanently disable authenticated bootstrap", async () => {
    for (const rejected of [false, true]) {
        const h = startupHarness();
        let calls = 0;
        h.api.setHttp({
            get: async () => {
                calls++;
                if (calls > 1) return { ok: true, status: 200, body: { id: "123" } };
                const response = { ok: false, status: 401, body: {} };
                if (rejected) throw response;
                return response;
            },
        });
        h.api.startWhenReady();
        await flush();
        assert.equal(h.api.initialized(), false);
        h.advance(10000);
        h.api.startWhenReady();
        await flush();
        assert.equal(calls, 2);
        assert.equal(h.api.initialized(), true);
    }
});

test("late anonymous unauthorized responses cannot end a newly initialized session", async () => {
    for (const rejected of [false, true]) {
        const h = startupHarness();
        const response = deferred();
        h.api.setHttp({ get: () => response.promise });
        const request = h.api.api.request("get", "/users/@me");
        const failure = assert.rejects(request, (error) => error.status === 401);
        await h.api.start("123");
        const unauthorized = { ok: false, status: 401, body: {} };
        if (rejected) response.reject(unauthorized);
        else response.resolve(unauthorized);
        await failure;
        h.api.setHttp({ get: async () => ({ ok: true, status: 200, body: { preserved: true } }) });
        assert.equal((await h.api.api.request("get", "/users/@me/e2ee")).preserved, true);
    }
});

test("authenticated unauthorized responses still stop encryption requests", async () => {
    for (const rejected of [false, true]) {
        const h = startupHarness();
        await h.api.start("123");
        let calls = 0;
        h.api.setHttp({
            get: async () => {
                calls++;
                const response = { ok: false, status: 401, body: {} };
                if (rejected) throw response;
                return response;
            },
        });
        await assert.rejects(h.api.api.request("get", "/users/@me/e2ee"), (error) => error.status === 401);
        await assert.rejects(h.api.api.request("get", "/users/@me/e2ee"), (error) => error.status === 401);
        assert.equal(calls, 1);
    }
});
