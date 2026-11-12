const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const ts = require("typescript");

async function load(relative, assets, overrides = {}) {
    const source = await fs.readFile(path.join(__dirname, "../..", relative), "utf8");
    const js = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const exported = { exports: {} };
    const context = vm.createContext({
        module: exported,
        exports: exported.exports,
        Buffer,
        AbortSignal,
        process: { env: overrides.env ?? {}, pid: process.pid },
        console: { error() {}, log() {} },
        fetch:
            overrides.fetch ??
            (() => {
                throw new Error("Unexpected network request");
            }),
        setInterval: () => ({
            unref() {
                return this;
            },
        }),
        require(id) {
            if (id.endsWith("/Constants") || id === "./Constants") return { ASSETS_FOLDER: assets };
            if (id.endsWith("/Config") || id === "./Config")
                return {
                    Config: {
                        get: () => ({
                            cdn: { endpointPublic: "http://local-cdn", endpointPrivate: "http://local-cdn" },
                        }),
                    },
                };
            if (id === "./ProcessLifecycle") return { ProcessLifecycle: { eventEmitter: new (require("node:events").EventEmitter)() } };
            if (id === "./Branding") return { instanceName: () => "Test instance" };
            if (id === "./SteamFrames") return { steamFrameCategory: () => ({ products: [] }), steamFrameRecency: () => undefined };
            if (id === "node:fs/promises" && overrides.fs) return overrides.fs;
            if (id === "jimp" && overrides.jimp) return overrides.jimp;
            return require(id);
        },
    });
    vm.runInContext(js, context, { filename: relative });
    return exported.exports;
}

test("cached shop search preserves stable sorting, variants, duplicate precedence, relevance and filters", async () => {
    const { Collectibles } = await load("src/util/util/Collectibles.ts", "/tmp");
    const alpha = {
        sku_id: "100",
        name: "Alpha",
        type: 0,
        is_first_party: false,
        items: [{ label: "special" }],
    };
    const beta = { sku_id: "200", name: "Beta", type: 2, items: [{ label: "alpha" }] };
    const variants = {
        sku_id: "300",
        name: "Alpha",
        type: 2000,
        is_first_party: false,
        variants: [{ type: 2 }],
        items: [{ label: "special" }],
    };
    let snapshot = {
        categories: [
            {
                sku_id: "1",
                name: "Decor pack",
                products: [alpha, beta, variants, { sku_id: "400", name: "Not a cosmetic", type: 50 }],
            },
            { sku_id: "2", name: "Other", products: [{ ...alpha, name: "Duplicate" }] },
        ],
        products: new Map(),
        items: new Map(),
    };
    Collectibles.get = async () => snapshot;
    const skus = async (options) => Array.from((await Collectibles.search(options)).skus);
    assert.deepEqual(await skus({}), ["300", "200", "100"]);
    assert.deepEqual(await skus({ sort_type: "alphabetical", sort_direction: "asc" }), ["100", "300", "200"]);
    assert.deepEqual(await skus({ sort_type: "price" }), ["200", "100", "300"]);
    assert.deepEqual(await skus({ sort_type: "popularity" }), ["100", "200", "300"]);
    assert.deepEqual(await skus({ sort_type: "popularity", sort_direction: "asc" }), ["300", "200", "100"]);
    assert.deepEqual(await skus({ search: "ALPHA", sort_type: "relevance" }), ["300", "100", "200"]);
    assert.deepEqual(await skus({ search: "ALPHA", sort_type: "relevance", sort_direction: "asc" }), ["200", "300", "100"]);
    assert.deepEqual(await skus({ search: "special", item_types: ["NAMEPLATE"], first_party: false }), ["300"]);
    const page = await Collectibles.search({ offset: 1, limit: 1 });
    assert.deepEqual(Array.from(page.skus), ["200"]);
    assert.equal(page.pagination.total, 3);
    assert.equal(page.pagination.has_more, true);
    assert.equal((await Collectibles.search({ search: "duplicate" })).pagination.total, 0);
    snapshot = { ...snapshot, categories: [{ ...snapshot.categories[0], name: "Updated pack" }] };
    assert.equal((await Collectibles.search({ search: "decor" })).pagination.total, 0);
    assert.equal((await Collectibles.search({ search: "updated" })).pagination.total, 3);
});

test("100k cosmetic searches reuse text and type indexing after warmup and invalidate on a new snapshot", async () => {
    const { Collectibles } = await load("src/util/util/Collectibles.ts", "/tmp");
    let typeReads = 0,
        textReads = 0;
    const products = Array.from({ length: 100000 }, (_, i) => ({
        sku_id: String(100000000000000000n + BigInt(i)),
        name: "Decoration " + i,
        get type() {
            typeReads++;
            return 0;
        },
        get items() {
            textReads++;
            return [{ label: "Art " + i }];
        },
    }));
    let snapshot = {
        categories: [{ sku_id: "1", name: "Pack", products }],
        products: new Map(),
        items: new Map(),
    };
    Collectibles.get = async () => snapshot;
    const options = { search: "decoration 123", sort_type: "recency", limit: 50 };
    const first = await Collectibles.search(options);
    const reads = { type: typeReads, text: textReads };
    for (let i = 0; i < 3; i++) assert.equal(JSON.stringify(await Collectibles.search(options)), JSON.stringify(first));
    assert.equal(typeReads, reads.type);
    assert.equal(textReads, reads.text);
    assert.equal(textReads, 100000);
    snapshot = { ...snapshot, categories: [] };
    assert.equal((await Collectibles.search(options)).pagination.total, 0);
});
