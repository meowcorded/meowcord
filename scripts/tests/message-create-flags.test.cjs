const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const compile = (file, imports, fallback = false) => {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        }).outputText,
        {
            module,
            exports: module.exports,
            Date,
            require: (name) => {
                if (name in imports) return imports[name];
                assert.ok(fallback, `missing mock for ${name}`);
                return {};
            },
        },
    );
    return module.exports;
};

const { MessageFlags } = compile("src/util/util/MessageFlags.ts", { "./BitField": compile("src/util/util/BitField.ts", {}) });
const spoofed = Number(MessageFlags.FLAGS.URGENT | MessageFlags.FLAGS.EPHEMERAL | MessageFlags.FLAGS.IS_CROSSPOST | MessageFlags.FLAGS.LOADING);
const allowed = Number(MessageFlags.FLAGS.SUPPRESS_EMBEDS | MessageFlags.FLAGS.SUPPRESS_NOTIFICATIONS);
const stop = new Error("captured");

test("a user message keeps only the flags a user may set", async () => {
    let captured;
    const { publishUserMessage } = compile(
        "src/api/util/handlers/UserMessage.ts",
        {
            "@spacebar/util": { MessageFlags },
            "@spacebar/schemas": { MessageType: {}, MessageReferenceType: { DEFAULT: 0, FORWARD: 1 } },
            "./Message": {
                handleMessage: async (opts) => {
                    captured = opts;
                    throw stop;
                },
            },
        },
        true,
    );
    const send = (body) =>
        assert.rejects(
            () => publishUserMessage({ channel: { id: "channel-1" }, user_id: "user-1", body, message_id: "message-1", attachments: [] }),
            (err) => err === stop,
        );

    await send({ content: "Urgent message from staff", flags: spoofed | allowed });
    assert.equal(captured.flags, allowed);
    await send({ content: "forward", flags: Number(MessageFlags.FLAGS.HAS_SNAPSHOT), message_reference: { type: 1, message_id: "1", channel_id: "2" } });
    assert.equal(captured.flags, Number(MessageFlags.FLAGS.HAS_SNAPSHOT));
    await send({ content: "not a forward", flags: Number(MessageFlags.FLAGS.HAS_SNAPSHOT) });
    assert.equal(captured.flags, 0);
});

test("a webhook message keeps only the flags a webhook may set", async () => {
    let captured;
    const webhook = { id: "hook-1", token: "token", channel_id: "channel-1", channel: { id: "channel-1", isWritable: () => true }, application: null };
    const { executeWebhook } = compile(
        "src/api/util/handlers/Webhook.ts",
        {
            "@spacebar/util": {
                MessageFlags,
                Config: { get: () => ({ limits: { absoluteRate: { sendMessage: { enabled: false } } } }) },
                Snowflake: { generate: () => "message-1" },
                uploadMessageFiles: async () => [],
                ValidateName: () => {},
            },
            "@spacebar/database": { Webhook: { findOne: async () => webhook } },
            "../utility/tokenEquals": require("../../dist/api/util/utility/tokenEquals.js"),
            "./Message": {
                handleMessage: async (opts) => {
                    captured = opts;
                    throw stop;
                },
            },
        },
        true,
    );
    const res = { status: () => res, send: () => res, json: () => res };
    await assert.rejects(
        () => executeWebhook({ body: { content: "Urgent", flags: spoofed | allowed }, params: { webhook_id: "hook-1", webhook_token: "token" }, query: { wait: "true" } }, res),
        (err) => err === stop,
    );
    assert.equal(captured.flags, allowed);
});
