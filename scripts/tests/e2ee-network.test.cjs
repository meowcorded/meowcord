const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (file, globals = {}) => {
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, { module, exports: module.exports, ...globals });
    return module.exports;
};

const network = load("client/e2ee/src/network.ts");

test("request failures keep HTTP errors and wrap transport failures", () => {
    const unauthorized = { status: 401, body: { message: "unauthorized" } };
    const serverError = { status: 500, body: {} };
    const transport = new TypeError("fetch failed");

    assert.equal(network.requestFailure(unauthorized), unauthorized);
    assert.equal(network.requestFailure(serverError), serverError);

    const wrapped = network.requestFailure(transport);
    assert.ok(wrapped instanceof network.EncryptionNetworkError);
    assert.equal(wrapped.cause, transport);
    assert.equal(wrapped.message, "Encryption couldn't reach the server");

    const zero = network.requestFailure({ status: 0 });
    assert.ok(zero instanceof network.EncryptionNetworkError);
    assert.equal(zero.cause.status, 0);

    const missing = network.requestFailure(null);
    assert.ok(missing instanceof network.EncryptionNetworkError);
    assert.equal(missing.cause, null);
});

test("only transport, timeout, rate-limit and server failures are transient", () => {
    for (const error of [
        new network.EncryptionNetworkError(new TypeError("fetch failed")),
        { status: 0 },
        { status: 400 },
        { status: 401 },
        { status: 403 },
        { status: 404 },
        { status: 408 },
        { status: 429 },
        { status: 500 },
        { status: 503 },
        new Error("invalid signature"),
        null,
    ]) {
        const expected = error instanceof network.EncryptionNetworkError || [0, 408, 429, 500, 503].includes(error?.status);
        assert.equal(network.isTransientRequestError(error), expected, JSON.stringify(error));
    }
});
