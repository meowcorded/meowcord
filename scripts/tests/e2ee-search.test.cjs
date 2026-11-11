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

const search = load("client/e2ee/src/search.ts", { URLSearchParams });
const plain = (value) => JSON.parse(JSON.stringify(value));
const message = (extra = {}) => ({
    id: "1",
    channel_id: "10",
    content: "Hello WORLD https://example.test/path",
    author: { id: "5" },
    ...extra,
});

test("search queries collect repeated and bracketed array parameters", () => {
    const query = search.readSearchQuery(new URLSearchParams("content=Holiday&author_id=1&author_id[1]=2&has[0]=image&has[]=-file&offset=5&limit=10&sort_order=asc"));
    assert.deepEqual(plain(query), {
        content: "Holiday",
        author_id: ["1", "2"],
        has: ["image", "-file"],
        offset: "5",
        limit: "10",
        sort_order: "asc",
    });
});

test("search queries ignore unrelated bracket names", () => {
    const query = search.readSearchQuery(new URLSearchParams("has[foo]=image&has[0]=link"));
    assert.deepEqual(plain(query.has), ["link"]);
});

test("search requires every content word and matches authors", () => {
    assert.equal(search.matchesSearch(message(), { content: "hello world" }), true);
    assert.equal(search.matchesSearch(message(), { content: "hello missing" }), false);
    assert.equal(search.matchesSearch(message(), { author_id: "5" }), true);
    assert.equal(search.matchesSearch(message(), { author_id: ["4", "5"] }), true);
    assert.equal(search.matchesSearch(message(), { author_id: "4" }), false);
});

test("search contains filters match decrypted media, files, links and stickers", () => {
    assert.equal(search.matchesSearch(message(), { has: "link" }), true);
    assert.equal(search.matchesSearch(message(), { has: "file" }), false);
    assert.equal(search.matchesSearch(message(), { has: "image" }), false);
    assert.equal(search.matchesSearch(message({ attachments: [{ content_type: "image/png" }] }), { has: "image" }), true);
    assert.equal(search.matchesSearch(message({ attachments: [{ content_type: "video/mp4" }] }), { has: "video" }), true);
    assert.equal(search.matchesSearch(message({ attachments: [{ content_type: "audio/mpeg" }] }), { has: "sound" }), true);
    assert.equal(search.matchesSearch(message({ sticker_items: [{ id: "1" }] }), { has: "sticker" }), true);
    assert.equal(search.matchesSearch(message({ embeds: [{ type: "rich", image: { url: "https://example.test/a.png" } }] }), { has: "image" }), true);
    assert.equal(search.matchesSearch(message({ embeds: [{ type: "video" }] }), { has: "video" }), true);
    assert.equal(search.matchesSearch(message({ embeds: [{ type: "rich" }] }), { has: "embed" }), true);
});

test("positive contains filters are ORed and exclusions are ANDed", () => {
    const image = message({ attachments: [{ content_type: "image/png" }] });
    assert.equal(search.matchesSearch(image, { has: ["link", "image"] }), true);
    assert.equal(search.matchesSearch(image, { has: ["video", "sound"] }), false);
    assert.equal(search.matchesSearch(image, { has: ["-file"] }), false);
    assert.equal(search.matchesSearch(image, { has: ["-video"] }), true);
    assert.equal(search.matchesSearch(image, { has: ["link", "-file"] }), false);
    assert.equal(search.matchesSearch(image, { has: ["link", "-video"] }), true);
});

test("empty queries pass and unknown filters do not match messages", () => {
    assert.equal(search.matchesSearch(message(), {}), true);
    assert.equal(search.matchesSearch(message(), { content: "   " }), true);
    assert.equal(search.matchesSearch(message(), { has: "unknown" }), false);
    assert.equal(search.matchesSearch(message(), { has: "-unknown" }), true);
});
