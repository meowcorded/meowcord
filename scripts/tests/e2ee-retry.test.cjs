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

function harness() {
    const timers = [];
    let now = 0;
    const calls = [];
    let remainingFailures = 0;
    let failure = { status: 503 };
    const states = new Map();

    const engine = {
        trustsServer: false,
        cached: () => undefined,
        decrypt: async (message) => {
            calls.push(message.id);
            if (remainingFailures > 0) {
                remainingFailures--;
                throw failure;
            }
            return { content: "decrypted", attachments: [], stickers: [] };
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
        },
    );

    const instance = hooks.createHooks({
        engine,
        states,
        attachments: { apply: () => {} },
        sticker: () => null,
        ready: Promise.resolve(true),
        failClosed: () => false,
        isReady: () => true,
        onState: () => {},
        updateRecord: () => {},
        onCredentials: () => {},
        onLogout: () => {},
        onError: () => {},
        fetchEmbeds: async () => ({}),
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

test("a transient failure is queued and retried without waiting for a reload", async () => {
    const h = harness();
    h.fail(1, { status: 503 });
    await h.instance.decryptAll([message()]);
    assert.equal(h.states.get("1").state, "failed");
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 30_000);

    h.succeed();
    h.instance.retryAll();
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

    h.instance.retryAll();
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
    h.instance.retryAll();
    await flush();
    assert.equal(h.calls.length, 300 + 256);
});
