const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const plain = (value) => JSON.parse(JSON.stringify(value));

const load = () => {
    const source = ts.createSourceFile("engine.ts", fs.readFileSync("client/e2ee/src/engine.ts", "utf8"), ts.ScriptTarget.Latest, true);
    const engine = source.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === "Engine");
    const methods = ["lookupStoredKey", "flushLookups"].map((name) =>
        engine.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name).getText(source),
    );
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(`class Extracted { ${methods.join("\n")} };module.exports=Extracted;`, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            setTimeout: () => 1,
            console: { error() {} },
        },
    );
    const instance = new module.exports();
    Object.assign(instance, { storedKeys: new Map(), lookups: new Map(), lookupTimer: null });
    return instance;
};

test("backup key lookups reject transient failures instead of resolving as missing", async () => {
    const engine = load();
    const failure = { status: 503, body: { message: "unavailable" } };
    engine.api = { request: async () => Promise.reject(failure) };

    const lookup = engine.lookupStoredKey("123");
    await engine.flushLookups();
    await assert.rejects(lookup, (error) => error === failure);
});

test("backup key lookups resolve stored keys and cache them", async () => {
    const engine = load();
    engine.api = {
        request: async () => ({ keys: [{ message_id: "123", enc: "encrypted", wrapped: "wrapped" }] }),
    };

    const lookup = engine.lookupStoredKey("123");
    await engine.flushLookups();
    const result = await lookup;
    assert.equal(result.enc, "encrypted");
    assert.equal(result.wrapped, "wrapped");
    assert.ok(engine.storedKeys.has("123"));
});
