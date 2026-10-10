const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function storeHarness(options = {}) {
    let source;
    let nextId = 100;
    const filename = path.resolve(__dirname, "../../src/api/util/utility/store.ts");
    const js = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    const types = { AVATAR_DECORATION: 0, PROFILE_EFFECT: 1, NAMEPLATE: 2, PROFILE_FRAME: 3 };
    vm.runInNewContext(
        js,
        {
            module,
            exports: module.exports,
            Buffer,
            require(name) {
                if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
                if (name === "@spacebar/database")
                    return {
                        StorePack: { find: async () => options.packs ?? [] },
                        StoreItem: { find: async () => options.items ?? [] },
                        StoreHiddenPack: { find: async () => [] },
                    };
                if (name === "@spacebar/util")
                    return {
                        CollectibleItemType: types,
                        Collectibles: {
                            setCustomSource: (fn) => {
                                source = fn;
                            },
                        },
                        Config: { get: () => ({ cdn: { endpointPublic: "http://local" } }) },
                        deleteFile: options.deleteFile ?? (async () => {}),
                        uploadFile: options.uploadFile ?? (async () => ({ hash: "new-hash", content_type: "image/png" })),
                        Snowflake: { generate: () => String(nextId++) },
                    };
                if (name === "lambert-server/HTTPError") return { HTTPError: class extends Error {} };
                throw new Error(`Unexpected import: ${name}`);
            },
        },
        { filename },
    );
    return { ...module.exports, customSource: () => source() };
}
const pack = (id) => ({
    id: String(id),
    name: `Pack ${id}`,
    summary: "",
    position: id,
    created_at: new Date(0),
});
const item = (id, packId, position = id) => ({
    id: String(id),
    pack_id: String(packId),
    name: `Item ${id}`,
    label: "Art",
    summary: "",
    type: 0,
    position,
    created_at: new Date(0),
    data: { assets: { static: "hash" } },
});
const plain = (value) => JSON.parse(JSON.stringify(value));

test("grouped pack serialization preserves existing array API, ordering and orphan exclusion", () => {
    const h = storeHarness();
    const items = [item(1, 1, 2), item(2, 2), item(3, 1, 1), item(4, 9)];
    const before = items.slice();
    const grouped = h.groupStoreItems(items);
    for (const p of [pack(1), pack(2), pack(3)]) assert.deepEqual(plain(h.serializeStorePack(p, grouped)), plain(h.serializeStorePack(p, items)));
    assert.deepEqual(items, before);
    assert.deepEqual(
        plain(h.serializeStorePack(pack(1), grouped)).items.map((x) => x.id),
        ["3", "1"],
    );
});

test("custom catalog groups 100,000 items once instead of scanning every item for every pack", async () => {
    let packReads = 0;
    const packs = Array.from({ length: 1000 }, (_, i) => pack(i));
    const items = Array.from({ length: 100000 }, (_, i) => {
        const value = item(i, i % packs.length);
        Object.defineProperty(value, "pack_id", {
            get() {
                packReads++;
                return String(i % packs.length);
            },
        });
        return value;
    });
    const h = storeHarness({ packs, items });
    const catalog = await h.customSource();
    assert.equal(catalog.categories.length, 1000);
    assert.equal(
        catalog.categories.reduce((count, category) => count + category.products.length, 0),
        100000,
    );
    // One read during grouping and one when creating each product. Quadratic code reads 100 million times.
    assert.equal(packReads, items.length * 2);
});

test("large pack deletion shares a bounded budget, drains all slots and tolerates missing art", async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const seen = new Set();
    const h = storeHarness({
        deleteFile: async (filename) => {
            active++;
            peak = Math.max(peak, active);
            calls++;
            seen.add(filename);
            await new Promise((resolve) => setImmediate(resolve));
            active--;
            if (calls % 13 === 0) throw new Error("File already absent");
        },
    });
    const items = Array.from({ length: 200 }, (_, i) => ({
        ...item(i, 1),
        data: {
            assets: Object.fromEntries(Array.from({ length: 30 }, (_, slot) => [`slot${slot}`, "hash"])),
        },
    }));
    await h.deleteStorePackArt(pack(1), items);
    assert.equal(calls, 6002);
    assert.equal(seen.size, calls);
    assert.equal(active, 0);
    assert.equal(peak, 8);
    assert.ok(seen.has("/media/v1/collectibles-shop/1/banner"));
    calls = 0;
    await h.deleteAllStoreArt(items[0]);
    assert.equal(calls, 30);
});

test("catalog ties use exact numeric IDs independently of database return order", async () => {
    const low = "9007199254740992";
    const high = "9007199254740993";
    const packs = [pack(high), pack(low), pack(9)].map((value) => ({ ...value, position: 0 }));
    const items = [item(high, low, 0), item(low, low, 0), item(9, low, 0)];
    const expected = ["9", low, high];
    for (const values of [items, items.slice().reverse()]) {
        const h = storeHarness({ packs: packs.slice(), items: values });
        assert.deepEqual(
            plain(h.serializeStorePack(pack(low), values)).items.map((value) => value.id),
            expected,
        );
        assert.deepEqual(
            plain(packs.slice().sort(h.sortStoreByPosition)).map((value) => value.id),
            expected,
        );
        const catalog = await h.customSource();
        assert.deepEqual(
            plain(catalog.categories).map((value) => value.sku_id),
            expected,
        );
        assert.deepEqual(
            plain(catalog.categories.find((value) => value.sku_id === low).products).map((value) => value.sku_id),
            expected,
        );
    }
});

test("refused frame replacements preserve existing layers and clean up accepted temporary uploads", async () => {
    const deleted = [];
    let uploads = 0;
    const h = storeHarness({
        deleteFile: async (filename) => deleted.push(filename),
        uploadFile: async () => {
            if (++uploads === 2) throw new Error("refused");
            return { hash: "replacement", content_type: "image/png" };
        },
    });
    const frame = {
        ...item(1, 1),
        type: 3,
        data: {
            assets: { "layer:10": "old-top", "layer:11": "old-bottom" },
            layers: [
                { id: "10", order: "front", anchor: "top" },
                { id: "11", order: "front", anchor: "bottom" },
            ],
        },
    };
    const before = plain(frame);
    await assert.rejects(
        h.applyStoreArt(frame, {
            front_top: "data:image/png;base64,YQ==",
            front_bottom: "data:image/png;base64,Yg==",
        }),
        /refused/,
    );
    assert.deepEqual(plain(frame), before);
    assert.deepEqual(deleted, ["/media/v1/collectibles-shop/1/100/static"]);
    const successful = storeHarness({ deleteFile: async (filename) => deleted.push(filename) });
    await successful.applyStoreArt(frame, { front_top: "data:image/png;base64,YQ==" });
    assert.equal(frame.data.assets["layer:100"], "new-hash");
    assert.equal(frame.data.assets["layer:10"], undefined);
    assert.equal(frame.data.assets["layer:11"], "old-bottom");
    assert.equal(frame.data.layers.find((layer) => layer.anchor === "top").id, "100");
    assert.equal(deleted.at(-1), "/media/v1/collectibles-shop/1/10/static");
});
