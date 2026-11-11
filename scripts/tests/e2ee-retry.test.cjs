const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const compile = (file) =>
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

const load = (file, imports, globals = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(compile(file), {
        module,
        exports: module.exports,
        require: (name) => {
            if (name in imports) return imports[name];
            throw new Error(`unexpected import ${name}`);
        },
        ...globals,
    });
    return module.exports;
};

const BoundedMap = load("client/e2ee/src/boundedMap.ts", {}).BoundedMap;
const search = load("client/e2ee/src/search.ts", {}, { URLSearchParams });
const network = load("client/e2ee/src/network.ts", {});

const flush = async () => {
    for (let i = 0; i < 100; i++) await Promise.resolve();
};

function harness(options = {}) {
    const timers = [];
    let now = 0;
    const calls = [];
    let remainingFailures = 0;
    let failure = { status: 503 };
    const states = new Map();

    const engine = {
        trustsServer: false,
        cached: () => undefined,
        isEncrypted: () => true,
        decrypt: async (message) => {
            calls.push(message.id);
            if (remainingFailures > 0) {
                remainingFailures--;
                throw failure;
            }
            return options.payload ?? { content: "decrypted", attachments: [], stickers: [] };
        },
    };

    class E2eeError extends Error {
        constructor(code, message) {
            super(message);
            this.code = code;
        }
    }

    const hooks = load(
        "client/e2ee/src/hooks.ts",
        {
            "./engine": {
                E2eeError,
                Engine: class {},
                errorText: (error) => error?.message ?? "failed",
                FALLBACK_CONTENT: "fallback",
                mentionedIn: () => new Set(),
                PLAINTEXT_CACHE_SIZE: 1000,
            },
            "./boundedMap": { BoundedMap },
            "./search": search,
            "./network": network,
            "./i18n": { t: (text) => text },
        },
        {
            setTimeout: (fn, ms) => {
                const timer = { fn, ms, at: now + ms, done: false };
                timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => {
                if (timer) timer.done = true;
            },
            console,
            URLSearchParams,
        },
    );

    const instance = hooks.createHooks({
        engine,
        states,
        attachments: { apply: options.apply ?? (() => {}) },
        sticker: () => null,
        ready: Promise.resolve(true),
        failClosed: () => false,
        isReady: () => true,
        onState: () => {},
        updateRecord: () => {},
        onCredentials: () => {},
        onLogout: () => {},
        onError: () => {},
        fetchEmbeds: options.fetchEmbeds ?? (async () => ({})),
        fetchSoundmoji: async () => [],
    });

    return {
        instance,
        states,
        calls,
        timers,
        fail: (count, error = { status: 503 }) => {
            remainingFailures = count;
            failure = error;
        },
        succeed: () => {
            remainingFailures = 0;
        },
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

const message = (id = "1") => ({
    id,
    channel_id: "10",
    content: "fallback",
    author: { id: "5" },
    encrypted: { sig: `sig-${id}` },
});

const http = (getBody = []) => {
    const gets = [];
    const calls = Object.fromEntries(
        ["get", "post", "put", "patch", "del"].map((method) => [
            method,
            async (options) => {
                if (method === "get") gets.push(options);
                return { ok: true, status: 200, body: method === "get" ? getBody : {} };
            },
        ]),
    );
    return { calls, gets };
};

const deferred = () => {
    let resolve;
    const promise = new Promise((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
};

test("a transient failure is queued and retried without waiting for a reload", async () => {
    const h = harness();
    h.fail(1, { status: 503 });
    await h.instance.decryptAll([message()]);
    assert.equal(h.states.get("1").state, "failed");
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 30_000);

    h.succeed();
    h.instance.retryAll(true);
    await flush();
    assert.equal(h.states.get("1").state, "decrypted");
    assert.deepEqual(h.calls, ["1", "1"]);
});

test("the retry timer delivers a delayed decryption", async () => {
    const h = harness();
    h.fail(1, { status: 500 });
    await h.instance.decryptAll([message()]);
    assert.equal(h.states.get("1").state, "failed");

    h.succeed();
    h.advance(30_000);
    await flush();
    assert.equal(h.states.get("1").state, "decrypted");
    assert.deepEqual(h.calls, ["1", "1"]);
});

test("a rate limit uses the server's longer retry delay", async () => {
    const h = harness();
    h.fail(1, { status: 429, body: { retry_after: 65 } });
    await h.instance.decryptAll([message()]);
    assert.equal(h.timers[0].ms, 66_000);
});

test("non-transient failures are not queued for retry", async () => {
    const h = harness();
    h.fail(1, { status: 404 });
    await h.instance.decryptAll([message()]);
    assert.equal(h.states.get("1").state, "failed");
    assert.equal(h.timers.length, 0);

    h.instance.retryAll(true);
    await flush();
    assert.deepEqual(h.calls, ["1"]);
});

test("a burst of transient failures shares one retry timer", async () => {
    const h = harness();
    h.fail(3, { status: 503 });
    await h.instance.decryptAll([message("1"), message("2"), message("3")]);
    assert.equal(h.timers.length, 1);
    assert.deepEqual(
        [...h.states.values()].map(({ state }) => state),
        ["failed", "failed", "failed"],
    );
});

test("the retry queue keeps at most 256 messages", async () => {
    const h = harness();
    const messages = Array.from({ length: 300 }, (_, index) => message(String(index + 1)));
    h.fail(300, { status: 503 });
    await h.instance.decryptAll(messages);
    h.succeed();
    h.instance.retryAll(true);
    await flush();
    assert.equal(h.calls.length, 300 + 256);
});

test("a longer rate limit replaces the earlier retry deadline", async () => {
    const h = harness();
    h.fail(1, { status: 503 });
    await h.instance.decryptAll([message("1")]);
    h.advance(1000);
    h.fail(1, { status: 429, body: { retry_after: 120 } });
    await h.instance.decryptAll([message("2")]);

    assert.equal(h.timers[0].done, true);
    const pending = h.timers.filter((timer) => !timer.done);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].at, 122_000);

    h.succeed();
    h.instance.retryAll();
    await flush();
    assert.deepEqual(h.calls, ["1", "2"]);

    h.advance(30_000);
    await flush();
    assert.deepEqual(h.calls, ["1", "2"]);

    h.advance(91_000);
    await flush();
    assert.deepEqual(h.calls, ["1", "2", "1", "2"]);
});

test("evicted retry entries are recovered by refreshing the channel", async () => {
    const h = harness();
    const messages = Array.from({ length: 300 }, (_, index) => message(String(index + 1)));
    h.fail(300, { status: 503 });
    await h.instance.decryptAll(messages);
    h.succeed();

    const transport = http([message("1")]);
    h.instance.wrapHttp(transport.calls);
    h.instance.retryAll(true);
    await flush();
    await flush();
    await flush();

    assert.equal(transport.gets.length, 1);
    assert.equal(transport.gets[0].url, "/channels/10/messages");
    assert.equal(transport.gets[0].query.limit, 100);
    assert.equal(h.states.get("1").state, "decrypted");
});

test("media search waits for in-flight previews before filtering", async () => {
    const previews = deferred();
    const h = harness({
        payload: { content: "https://video.test/clip", attachments: [], stickers: [] },
        apply: (message, payload) => {
            message.content = payload.content;
        },
        fetchEmbeds: () => previews.promise,
    });
    const transport = http([]);
    h.instance.wrapHttp(transport.calls);

    await h.instance.decryptAll([message()]);
    let settled = false;
    const response = h.instance
        .wrapHttp(transport.calls)
        .get({ url: "/channels/10/messages/search", query: { has: "video" } })
        .then((value) => {
            settled = true;
            return value;
        });
    await flush();
    assert.equal(settled, false);

    previews.resolve({ "https://video.test/clip": [{ type: "video" }] });
    const result = await response;
    assert.equal(result.body.total_results, 1);
});
