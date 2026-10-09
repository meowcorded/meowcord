const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function load(file, imports = {}) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        { module, exports: module.exports, require: (name) => imports[name], URL, TextEncoder, TextDecoder },
    );
    return module.exports;
}
const notice = load("client/e2ee/src/safetyNoticeText.ts");
const files = load("client/e2ee/src/files.ts", { "./safetyNoticeText": notice, "./bytes": { fromB64u: () => new Uint8Array(), utf8: (v) => v } });
// values built inside the vm context have another realm's Array prototype, which deepStrictEqual rejects
const plain = (value) => JSON.parse(JSON.stringify(value));
const card = (extra = {}) => ({
    type: "safety_system_notification",
    fields: [
        { name: "icon_type", value: "danger" },
        { name: "theme", value: "danger" },
        { name: "header", value: "Your account is limited" },
        { name: "body", value: "Review and appeal your violations." },
        { name: "timestamp", value: "1791135304" },
    ],
    ...extra,
});
test("a safety card in the decrypted payload is kept", () => {
    const payload = files.parsePayload({ content: "fallback text", embeds: [card()] });
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].type, "safety_system_notification");
    assert.deepEqual(plain(payload.embeds[0].fields.map((f) => f.name)), ["icon_type", "theme", "header", "body", "timestamp"]);
});
test("only the two safety card types are accepted", () => {
    for (const type of ["rich", "link", "safety_policy_notice_x", undefined, 5]) assert.equal(files.parsePayload({ content: "", embeds: [card({ type })] }).embeds, undefined);
    assert.equal(files.parsePayload({ content: "", embeds: [card({ type: "safety_policy_notice" })] }).embeds.length, 1);
});
test("unknown field names, non-string values and oversized values are dropped", () => {
    const messy = card({
        fields: [
            { name: "header", value: "ok" },
            { name: "url", value: "https://example.com" },
            { name: "body", value: 7 },
            { name: "learn_more_link", value: "x".repeat(2001) },
            null,
        ],
    });
    assert.deepEqual(plain(files.parsePayload({ content: "", embeds: [messy] }).embeds[0].fields), [{ name: "header", value: "ok" }]);
});
test("a card with nothing usable in it is dropped, and at most one card is read", () => {
    assert.equal(files.parsePayload({ content: "", embeds: [card({ fields: [{ name: "nope", value: "x" }] })] }).embeds, undefined);
    assert.equal(files.parsePayload({ content: "", embeds: [card(), card(), card()] }).embeds.length, 1);
});
test("payloads without embeds, or with junk where embeds go, are unchanged", () => {
    assert.equal(files.parsePayload({ content: "hello" }).embeds, undefined);
    for (const junk of ["x", 5, {}, null, [null], [[]]]) assert.equal(files.parsePayload({ content: "hello", embeds: junk }).embeds, undefined);
    assert.equal(files.parsePayload({ content: "hello", embeds: [card()] }).content, "hello");
});
