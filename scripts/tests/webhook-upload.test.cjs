const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const ts = require("typescript");
const multer = require("multer");

function load() {
    const routes = {},
        uploads = [];
    const router = Object.fromEntries(["get", "post", "patch", "delete"].map((method) => [method, (path, ...handlers) => (routes[method] = handlers)]));
    const errors = {
        UNKNOWN_WEBHOOK: new Error("unknown"),
        INVALID_WEBHOOK_TOKEN_PROVIDED: new Error("invalid"),
    };
    let webhook = { id: "1", token: "valid" };
    const mockMulter = Object.assign(
        (options) => {
            uploads.push(options);
            return { any: () => (_req, _res, next) => next() };
        },
        { MulterError: multer.MulterError },
    );
    const mocks = {
        express: { Router: () => router },
        multer: mockMulter,
        "lambert-server/HTTPError": {
            HTTPError: class extends Error {
                constructor(message, code) {
                    super(message);
                    this.code = code;
                }
            },
        },
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/database": { Webhook: { findOne: async () => webhook } },
        "@spacebar/util": {
            Config: {
                get: () => ({ limits: { message: { maxAttachments: 3, maxAttachmentSize: 1024 } } }),
            },
            DiscordApiErrors: errors,
            getInteractionByToken: () => undefined,
        },
        "@spacebar/api/util/handlers/Webhook": {},
        "@spacebar/api/util/utility/tokenEquals": require("../../dist/api/util/utility/tokenEquals.js"),
    };
    const transpile = (file) => {
        const module = { exports: {} };
        vm.runInNewContext(
            ts.transpileModule(fs.readFileSync(path.join(__dirname, "../..", file), "utf8"), {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
            }).outputText,
            { module, exports: module.exports, require: (name) => mocks[name], Buffer, WeakMap },
        );
        return module.exports;
    };
    mocks["@spacebar/api/util/utility/boundedUpload"] = transpile("src/api/util/utility/boundedUpload.ts");
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, "../../src/api/routes/webhooks/#webhook_id/#webhook_token/index.ts"), "utf8");
    vm.runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => mocks[name],
            Buffer,
            WeakMap,
        },
    );
    return { handlers: routes.post, uploads, errors, setWebhook: (value) => (webhook = value) };
}

test("invalid webhook token is rejected before upload middleware can buffer data", async () => {
    const { handlers, uploads, errors, setWebhook } = load();
    const req = { params: { webhook_id: "1", webhook_token: "invalid" } };
    await assert.rejects(
        handlers[0](req, {}, () => assert.fail("invalid token continued")),
        errors.INVALID_WEBHOOK_TOKEN_PROVIDED,
    );
    assert.equal(uploads.length, 0);
    setWebhook(null);
    await assert.rejects(
        handlers[0](req, {}, () => assert.fail("missing webhook continued")),
        errors.UNKNOWN_WEBHOOK,
    );
    assert.equal(uploads.length, 0);
});

test("valid webhook honors lower instance limits and aggregate upload memory budget", async () => {
    const { handlers, uploads } = load();
    const req = { params: { webhook_id: "1", webhook_token: "valid" } };
    let continued = false;
    await handlers[0](req, {}, () => (continued = true));
    assert.equal(continued, true);
    handlers[1](req, {}, () => {});
    const { limits, storage } = uploads[0];
    assert.equal(limits.files, 3);
    assert.equal(limits.fileSize, 1024);
    assert.equal(limits.parts, 20);
    const stream = new EventEmitter();
    let calls = 0;
    storage._handleFile(req, { stream, fieldname: "files[0]" }, (error) => {
        calls++;
        assert.equal(error.code, "LIMIT_FILE_SIZE");
    });
    stream.emit("data", { length: 101 * 1024 * 1024 });
    stream.emit("data", Buffer.from("discard"));
    stream.emit("end");
    assert.equal(calls, 1);
});

test("small upload retains the exact bytes and releases its buffer on cleanup", () => {
    const { handlers, uploads } = load();
    const req = {};
    handlers[1](req, {}, () => {});
    const storage = uploads[0].storage;
    const stream = new EventEmitter();
    let result;
    storage._handleFile(req, { stream, fieldname: "files[0]" }, (error, info) => {
        assert.equal(error, null);
        result = info;
    });
    stream.emit("data", Buffer.from("hello"));
    stream.emit("data", Buffer.from(" world"));
    stream.emit("end");
    assert.equal(result.buffer.toString(), "hello world");
    assert.equal(result.size, 11);
    storage._removeFile(req, result, (error) => assert.equal(error, null));
    assert.equal(result.buffer, undefined);
});
