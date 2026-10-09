const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { BrandAssetCache } = require("../../src/util/util/BrandAssetCache.ts");
const { fetchBrandAsset, readBrandAssetFile, withinBrandImageLimits } = require("../../src/util/util/BrandAssetRequest.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function serverFixture(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        await run(`http://127.0.0.1:${server.address().port}/owned`);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

test("brand asset cache coalesces admitted loads and refuses overload without replacing pending work", async () => {
    const cache = new BrandAssetCache();
    const releases = [];
    let calls = 0;
    const load = () => {
        calls++;
        return new Promise((resolve) => releases.push(resolve));
    };
    const accepted = Array.from({ length: 4 }, (_, index) => cache.get(String(index), load));
    assert.equal(cache.get("0", load), accepted[0]);
    assert.equal(await cache.get("overflow", load), null);
    await turn();
    assert.equal(calls, 4);
    releases.forEach((release, index) => release(`asset-${index}`));
    assert.deepEqual(await Promise.all(accepted), ["asset-0", "asset-1", "asset-2", "asset-3"]);
    assert.equal(await cache.get("resumed", async () => "new"), "new");
});

test("brand asset cache evicts settled least-recently-used entries while preserving pending identity", async () => {
    const cache = new BrandAssetCache(3, 2);
    let release;
    const pending = cache.get("pending", () => new Promise((resolve) => (release = resolve)));
    await cache.get("old", async () => "old");
    await cache.get("recent", async () => "recent");
    await cache.get("old", async () => {
        throw Error("unexpected reload");
    });
    await cache.get("new", async () => "new");
    assert.equal(
        cache.get("pending", async () => "wrong"),
        pending,
    );
    let reloads = 0;
    assert.equal(
        await cache.get("recent", async () => {
            reloads++;
            return "reloaded";
        }),
        "reloaded",
    );
    assert.equal(reloads, 1);
    release("accepted");
    assert.equal(await pending, "accepted");
});

test("brand asset failures release admission and permit retries without rejected cache promises", async () => {
    const cache = new BrandAssetCache(2, 1);
    for (const fail of [
        () => {
            throw Error("owned failure");
        },
        async () => {
            throw Error("owned failure");
        },
        async () => null,
    ]) {
        assert.equal(await cache.get("owned", fail), null);
        assert.equal(await cache.get("owned", async () => "recovered"), "recovered");
        await cache.get("other", async () => "other");
        await cache.get("evict", async () => "evict");
    }
});

test("brand asset cache saturation never evicts unresolved entries", async () => {
    const cache = new BrandAssetCache(2, 4);
    const releases = [];
    const accepted = ["first", "second"].map((key) => cache.get(key, () => new Promise((resolve) => releases.push(resolve))));
    let called = false;
    assert.equal(
        await cache.get("third", async () => {
            called = true;
            return "third";
        }),
        null,
    );
    assert.equal(called, false);
    releases.forEach((release) => release("accepted"));
    await Promise.all(accepted);
    assert.equal(await cache.get("third", async () => "third"), "third");
});

test("brand image download accepts chunked binary data and normalizes its media type", async () => {
    await serverFixture(
        (_req, res) => {
            res.writeHead(200, { "content-type": "image/png; charset=binary" });
            res.write(Buffer.from([0, 255, 128]));
            res.end(Buffer.from([1, 2]));
        },
        async (url) => {
            assert.deepEqual(await fetchBrandAsset(url, true), {
                data: Buffer.from([0, 255, 128, 1, 2]),
                type: "image/png",
            });
        },
    );
});

for (const declared of [false, true])
    test(`brand image download cancels ${declared ? "declared" : "chunked"} oversized bodies`, async () => {
        await serverFixture(
            (_req, res) => {
                res.writeHead(200, {
                    "content-type": "image/png",
                    ...(declared ? { "content-length": String(9 * 1024 * 1024) } : {}),
                });
                res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
            },
            async (url) => {
                assert.equal(await fetchBrandAsset(url, true), null);
            },
        );
    });

test("brand image download accepts its exact byte ceiling", async () => {
    await serverFixture(
        (_req, res) => {
            res.writeHead(200, {
                "content-type": "image/png",
                "content-length": String(8 * 1024 * 1024),
            });
            res.end(Buffer.alloc(8 * 1024 * 1024, 17));
        },
        async (url) => {
            const asset = await fetchBrandAsset(url, true);
            assert.equal(asset.data.byteLength, 8 * 1024 * 1024);
            assert.ok(asset.data.every((byte) => byte === 17));
        },
    );
});

test("brand image embedding rejects non-image bodies while icon rendering permits missing media types", async () => {
    await serverFixture(
        (_req, res) => res.end("binary"),
        async (url) => {
            assert.equal(await fetchBrandAsset(url, true), null);
            assert.equal((await fetchBrandAsset(url)).data.toString(), "binary");
        },
    );
});

test("brand image HTTP and truncated-body failures resolve without retaining partial data", async () => {
    for (const failure of ["status", "truncated"]) {
        await serverFixture(
            (_req, res) => {
                res.writeHead(failure === "status" ? 503 : 200, {
                    "content-type": "image/png",
                    "content-length": "1024",
                });
                if (failure === "truncated") {
                    res.write("short");
                    const socket = res.socket;
                    setImmediate(() => socket.destroy());
                } else res.end("short");
            },
            async (url) => assert.equal(await fetchBrandAsset(url, true), null),
        );
    }
});

test("brand image download applies its five-second deadline to a stalled response body", { timeout: 8000 }, async () => {
    await serverFixture(
        (_req, res) => {
            res.writeHead(200, { "content-type": "image/png" });
            res.write("pending");
        },
        async (url) => {
            const start = Date.now();
            assert.equal(await fetchBrandAsset(url, true), null);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 4500 && elapsed < 7500, `deadline elapsed ${elapsed}`);
        },
    );
});

function brandingFixture(sourceLimits = false, holdFiles = false) {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const ts = require("typescript");
    const client = { icon: "https://owned.invalid/0", instanceName: "Owned instance" };
    const downloads = [];
    const decoded = [];
    const files = [];
    class Jimp {
        bitmap = { width: 64, height: 64 };
        static async read(source) {
            decoded.push(source);
            return new Jimp();
        }
        resize() {
            return this;
        }
        scaleToFit() {
            return this;
        }
        composite() {
            return this;
        }
        async getBuffer() {
            return Buffer.from("rendered");
        }
    }
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/Branding.ts", "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            require(name) {
                if (name === "./Config") return { Config: { get: () => ({ client, general: {} }) } };
                if (name === "../config/types/ClientConfiguration") return require("../../src/util/config/types/ClientConfiguration.ts");
                if (name === "./Constants") return { ASSETS_FOLDER: "/owned-assets" };
                if (name === "./DefaultAvatars") return { DEFAULT_AVATAR_COLORS: [] };
                if (name === "./BrandAssetCache") return { BrandAssetCache };
                if (name === "./BrandAssetRequest")
                    return {
                        fetchBrandAsset: (url) => new Promise((resolve) => downloads.push({ url, resolve })),
                        readBrandAssetFile: (file) =>
                            holdFiles ? new Promise((resolve) => files.push({ file, resolve })) : Promise.resolve(sourceLimits ? pngHeader(512, 512) : Buffer.from("image")),
                        withinBrandImageLimits: sourceLimits ? withinBrandImageLimits : () => true,
                    };
                if (name === "jimp") return { Jimp };
                return require(name);
            },
        },
    );
    return { client, downloads, decoded, files, branding: module.exports };
}

for (const operation of ["instanceIconDataUri", "appIconPng"])
    test(`branding ${operation} wires coalesced bounded jobs and preserves accepted output`, async () => {
        const h = brandingFixture();
        const run = () => h.branding[operation](192);
        const accepted = [];
        for (let index = 0; index < 4; index++) {
            h.client.icon = `https://owned.invalid/${index}`;
            accepted.push(run());
        }
        h.client.icon = "https://owned.invalid/overflow";
        assert.equal(await run(), null);
        h.client.icon = "https://owned.invalid/0";
        const duplicate = run();
        await turn();
        assert.equal(h.downloads.length, 4);
        h.downloads.forEach(({ resolve }) => resolve({ data: Buffer.from("image"), type: "image/png" }));
        const results = await Promise.all([...accepted, duplicate]);
        for (const result of results)
            assert.equal(operation === "appIconPng" ? result.toString() : result, operation === "appIconPng" ? "rendered" : "data:image/png;base64,aW1hZ2U=");
        assert.equal(h.downloads.length, 4);
        if (operation === "appIconPng") {
            assert.equal(await h.branding.appIconPng(100000), null);
            assert.equal(await h.branding.appIconPng(-1), null);
        }
    });

function pngHeader(width, height) {
    const data = Buffer.alloc(33);
    Buffer.from("89504e470d0a1a0a", "hex").copy(data);
    data.writeUInt32BE(13, 8);
    data.write("IHDR", 12);
    data.writeUInt32BE(width, 16);
    data.writeUInt32BE(height, 20);
    data[24] = 8;
    data[25] = 6;
    return data;
}

test("email images pass PNG sources through and convert other formats to bounded PNGs", async () => {
    const sharp = require("sharp");
    const h = brandingFixture();
    const dimensions = (png) => [png.readUInt32BE(16), png.readUInt32BE(20)];
    const render = async (kind, data) => {
        const pending = h.branding.emailImagePng(kind);
        await turn();
        h.downloads.pop().resolve(data && { data, type: "application/octet-stream" });
        return pending;
    };
    assert.equal(await h.branding.emailImagePng("wordmark"), null);
    assert.equal(h.downloads.length, 0);
    assert.equal(h.branding.emailImageUrls().logo, null);
    assert.match(h.branding.emailImageUrls().icon, /^\/static\/email\/icon\.png\?v=[0-9a-f]{8}$/);

    const png = pngHeader(4096, 4096);
    assert.equal(await render("icon", png), png);

    h.client.logo = "https://owned.invalid/wordmark.svg";
    const vector = await render("wordmark", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="56" height="18"><rect width="56" height="18" fill="#7B5CFF"/></svg>'));
    assert.equal(vector.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.deepEqual(dimensions(vector), [800, 257]);
    assert.match(h.branding.emailImageUrls().logo, /^\/static\/email\/wordmark\.png\?v=[0-9a-f]{8}$/);

    h.client.logo = "https://owned.invalid/wordmark.jpg";
    const large = await sharp({ create: { width: 2000, height: 500, channels: 3, background: "#7B5CFF" } })
        .jpeg()
        .toBuffer();
    assert.deepEqual(dimensions(await render("wordmark", large)), [800, 200]);

    h.client.icon = "https://owned.invalid/icon.webp";
    const small = await sharp({ create: { width: 40, height: 40, channels: 4, background: "#7B5CFF" } })
        .webp()
        .toBuffer();
    assert.deepEqual(dimensions(await render("icon", small)), [40, 40]);

    h.client.icon = "https://owned.invalid/broken";
    assert.equal(await render("icon", Buffer.from("not an image")), null);
    h.client.icon = "https://owned.invalid/missing";
    assert.equal(await render("icon", null), null);
});

test("branding checks source dimensions before decoder admission and preserves pixel boundaries", () => {
    for (const [width, height] of [
        [512, 512],
        [4096, 4096],
        [8192, 2048],
        [2048, 8192],
    ])
        assert.equal(withinBrandImageLimits(pngHeader(width, height)), true);
    for (const [width, height] of [
        [8193, 1],
        [1, 8193],
        [4097, 4096],
        [0, 1],
        [1, 0],
        [0xffffffff, 0xffffffff],
    ])
        assert.equal(withinBrandImageLimits(pngHeader(width, height)), false);
    assert.equal(withinBrandImageLimits(Buffer.from("not an image")), false);
    assert.equal(withinBrandImageLimits(Buffer.alloc(0)), false);
});

function trackedFileReader(createStream) {
    const fs = require("node:fs");
    const vm = require("node:vm");
    const ts = require("typescript");
    const streams = [];
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/BrandAssetRequest.ts", "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            AbortSignal,
            require(name) {
                if (name === "node:fs")
                    return {
                        constants: fs.constants,
                        createReadStream: (...args) => {
                            const stream = (createStream ?? fs.createReadStream)(...args);
                            streams.push(stream);
                            return stream;
                        },
                    };
                return require(name);
            },
        },
    );
    return { read: module.exports.readBrandAssetFile, streams };
}

test("local branding reads enforce the same byte ceiling and close every owned file stream", async () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-brand-file-");
    const file = `${directory}/owned.bin`;
    const h = trackedFileReader();
    try {
        for (const size of [0, 31, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1]) {
            fs.writeFileSync(file, "");
            const fd = fs.openSync(file, "r+");
            try {
                fs.ftruncateSync(fd, size);
            } finally {
                fs.closeSync(fd);
            }
            const result = await h.read(file);
            if (size > 8 * 1024 * 1024) assert.equal(result, null);
            else assert.equal(result.byteLength, size);
        }
        assert.equal(await h.read(`${directory}/missing.bin`), null);
        assert.equal(await h.read(directory), null);
        assert.ok(h.streams.every((stream) => stream.destroyed && stream.closed));
        assert.equal(await readBrandAssetFile(file), null);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("local image deadlines close stalled readers before and after their first chunk", { timeout: 5000 }, async () => {
    const fs = require("node:fs");
    const { Readable, addAbortSignal } = require("node:stream");
    const directory = fs.mkdtempSync("/tmp/meowcord-local-read-deadline-");
    const file = `${directory}/owned.bin`;
    fs.writeFileSync(file, "owned");
    try {
        for (const partial of [false, true]) {
            let fd;
            let sent = false;
            const h = trackedFileReader((_path, options) => {
                fd = options.fd;
                assert.equal(options.autoClose, false);
                return addAbortSignal(
                    options.signal,
                    new Readable({
                        read() {
                            if (partial && !sent) {
                                sent = true;
                                this.push(Buffer.from("partial"));
                            }
                        },
                    }),
                );
            });
            const start = Date.now();
            assert.equal(await h.read(file, { timeoutMs: 80 }), null);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 60 && elapsed < 1500, `local deadline elapsed ${elapsed}`);
            assert.equal(h.streams.length, 1);
            assert.ok(h.streams[0].destroyed && h.streams[0].closed);
            assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
        }
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("local image reads reject a real FIFO without waiting for a writer", { timeout: 5000 }, async () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-local-read-fifo-");
    const file = `${directory}/owned.fifo`;
    const h = trackedFileReader();
    try {
        const result = Bun.spawnSync(["mkfifo", file]);
        assert.equal(result.exitCode, 0);
        const start = Date.now();
        assert.equal(await h.read(file), null);
        assert.ok(Date.now() - start < 1500);
        assert.equal(h.streams.length, 0);
    } finally {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("oversized branding source pixels bypass the decoder and preserve the default PNG fallback", async () => {
    const h = brandingFixture(true);
    const result = h.branding.appIconPng(512);
    await turn();
    assert.equal(h.downloads.length, 1);
    h.downloads[0].resolve({ data: pngHeader(30000, 30000), type: "image/png" });
    assert.equal((await result).toString(), "rendered");
    assert.equal(h.decoded.length, 1);
    assert.deepEqual(h.decoded[0], pngHeader(512, 512));
});

test("local data-URI reads share the admission budget and refresh after same-path file changes", async () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-brand-cache-");
    const files = Array.from({ length: 5 }, (_, index) => `${directory}/${index}.png`);
    const h = brandingFixture(false, true);
    try {
        files.forEach((file) => fs.writeFileSync(file, "one"));
        const accepted = [];
        for (const file of files.slice(0, 4)) {
            h.client.icon = file;
            accepted.push(h.branding.instanceIconDataUri());
        }
        h.client.icon = files[4];
        assert.equal(await h.branding.instanceIconDataUri(), null);
        h.client.icon = files[0];
        const duplicate = h.branding.instanceIconDataUri();
        await turn();
        assert.equal(h.files.length, 4);
        h.files.forEach(({ resolve }) => resolve(Buffer.from("one")));
        const results = await Promise.all([...accepted, duplicate]);
        assert.ok(results.every((result) => result === "data:image/png;base64,b25l"));
        fs.writeFileSync(files[0], "two");
        const refreshed = h.branding.instanceIconDataUri();
        await turn();
        assert.equal(h.files.length, 5);
        h.files[4].resolve(Buffer.from("two"));
        assert.equal(await refreshed, "data:image/png;base64,dHdv");
    } finally {
        files.forEach((file) => fs.unlinkSync(file));
        fs.rmdirSync(directory);
    }
});

test("same-path branding updates change public versions and invalidate rendered PNG admission", async () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-brand-version-");
    const file = `${directory}/owned.png`;
    const h = brandingFixture(false, true);
    try {
        fs.writeFileSync(file, "one");
        h.client.icon = file;
        const first = { app: h.branding.appIconUrl(512), icon: h.branding.brandImageUrls().icon };
        const initial = h.branding.appIconPng(512);
        await turn();
        assert.equal(h.files.length, 1);
        h.files[0].resolve(Buffer.from("one"));
        await initial;
        assert.equal(h.branding.appIconUrl(512), first.app);
        fs.writeFileSync(file, "two");
        assert.notEqual(h.branding.appIconUrl(512), first.app);
        assert.notEqual(h.branding.brandImageUrls().icon, first.icon);
        const refreshed = h.branding.appIconPng(512);
        await turn();
        assert.equal(h.files.length, 2);
        h.files[1].resolve(Buffer.from("two"));
        await refreshed;
        assert.equal(h.decoded.length, 2);
        assert.deepEqual(h.decoded[1], Buffer.from("two"));
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("atomic icon replacement refreshes versions even with matching size and modification time", () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-brand-inode-");
    const file = `${directory}/owned.png`;
    const replacement = `${directory}/replacement.png`;
    const h = brandingFixture();
    try {
        fs.writeFileSync(file, "one");
        fs.utimesSync(file, 1700000000, 1700000000);
        const stat = fs.statSync(file, { bigint: true });
        h.client.icon = file;
        const previous = h.branding.appIconUrl(192);
        fs.writeFileSync(replacement, "two");
        fs.utimesSync(replacement, 1700000000, 1700000000);
        const next = fs.statSync(replacement, { bigint: true });
        assert.equal(next.size, stat.size);
        assert.equal(next.mtimeNs, stat.mtimeNs);
        assert.notEqual(next.ino, stat.ino);
        fs.renameSync(replacement, file);
        assert.notEqual(h.branding.appIconUrl(192), previous);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("remote icon versions stay stable across repeated requests and vary with configured URLs", () => {
    const h = brandingFixture();
    const first = h.branding.appIconUrl(512);
    assert.equal(h.branding.appIconUrl(512), first);
    h.client.icon = "https://owned.invalid/changed";
    assert.notEqual(h.branding.appIconUrl(512), first);
});

test("image reader accepts stricter byte ceilings and cancels declared and chunked overflow", async () => {
    for (const declared of [false, true]) {
        await serverFixture(
            (_req, res) => {
                res.writeHead(200, {
                    "content-type": "image/png",
                    ...(declared ? { "content-length": "1048577" } : {}),
                });
                res.end(Buffer.alloc(1048577));
            },
            async (url) => assert.equal(await fetchBrandAsset(url, false, { maxBytes: 1048576, timeoutMs: 1500 }), null),
        );
    }
    await serverFixture(
        (_req, res) => res.end(Buffer.alloc(1048576, 17)),
        async (url) => {
            const result = await fetchBrandAsset(url, false, { maxBytes: 1048576 });
            assert.equal(result.data.length, 1048576);
            assert.ok(result.data.every((byte) => byte === 17));
        },
    );
});

test("local image reader applies stricter ceilings without altering branding defaults", async () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-palette-file-");
    const file = `${directory}/owned.bin`;
    try {
        fs.writeFileSync(file, Buffer.alloc(1048576));
        assert.equal((await readBrandAssetFile(file, { maxBytes: 1048576 })).length, 1048576);
        fs.appendFileSync(file, "x");
        assert.equal(await readBrandAssetFile(file, { maxBytes: 1048576 }), null);
        assert.equal((await readBrandAssetFile(file)).length, 1048577);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("stricter image pixel limits reject oversized headers and retain exact boundaries", () => {
    const limits = { maxSide: 1024, maxPixels: 1048576 };
    assert.equal(withinBrandImageLimits(pngHeader(1024, 1024), limits), true);
    assert.equal(withinBrandImageLimits(pngHeader(1025, 1), limits), false);
    assert.equal(withinBrandImageLimits(pngHeader(1, 1025), limits), false);
    assert.equal(withinBrandImageLimits(pngHeader(1024, 1024), { maxPixels: 1048575 }), false);
    assert.equal(withinBrandImageLimits(pngHeader(4096, 4096)), true);
});

test("invalid image limits fail before network or file admission", async () => {
    const fs = require("node:fs");
    const directory = fs.mkdtempSync("/tmp/meowcord-image-limits-");
    const file = `${directory}/owned.png`;
    const h = trackedFileReader();
    let requests = 0;
    try {
        fs.writeFileSync(file, pngHeader(1, 1));
        await serverFixture(
            (_req, res) => {
                requests++;
                res.end(pngHeader(1, 1));
            },
            async (url) => {
                for (const limits of [{ maxBytes: 0 }, { maxBytes: Infinity }, { timeoutMs: -1 }, { timeoutMs: 5001 }, { maxSide: NaN }, { maxPixels: 16777217 }]) {
                    assert.equal(await fetchBrandAsset(url, false, limits), null);
                    assert.equal(await h.read(file, limits), null);
                    assert.equal(withinBrandImageLimits(pngHeader(1, 1), limits), false);
                }
            },
        );
        assert.equal(requests, 0);
        assert.equal(h.streams.length, 0);
    } finally {
        fs.unlinkSync(file);
        fs.rmdirSync(directory);
    }
});

test("image reader applies a stricter deadline throughout stalled body consumption", { timeout: 5000 }, async () => {
    await serverFixture(
        (_req, res) => {
            res.writeHead(200);
            res.write("pending");
        },
        async (url) => {
            const start = Date.now();
            assert.equal(await fetchBrandAsset(url, false, { timeoutMs: 1500, maxBytes: 1048576 }), null);
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 1250 && elapsed < 3500, `palette deadline elapsed ${elapsed}`);
        },
    );
});

function gifFrames(width, height, frames = 1) {
    const header = Buffer.alloc(13);
    header.write("GIF89a");
    header.writeUInt16LE(1, 6);
    header.writeUInt16LE(1, 8);
    header[10] = 128;
    const frame = Buffer.from([44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0]);
    frame.writeUInt16LE(width, 5);
    frame.writeUInt16LE(height, 7);
    return Buffer.concat([header, Buffer.from([255, 0, 0, 0, 0, 0]), ...Array.from({ length: frames }, () => frame), Buffer.from([59])]);
}

test("GIF source admission checks frame dimensions beyond the logical canvas", () => {
    const limits = { maxSide: 1024, maxPixels: 1048576 };
    assert.equal(withinBrandImageLimits(gifFrames(1024, 1024), limits), true);
    assert.equal(withinBrandImageLimits(gifFrames(1025, 1), limits), false);
    assert.equal(withinBrandImageLimits(gifFrames(1, 1025), limits), false);
    assert.equal(withinBrandImageLimits(gifFrames(30000, 30000), limits), false);
});

test("GIF admission bounds frame metadata and rejects truncated or missing image blocks", () => {
    assert.equal(withinBrandImageLimits(gifFrames(1, 1, 256)), true);
    assert.equal(withinBrandImageLimits(gifFrames(1, 1, 257)), false);
    assert.equal(withinBrandImageLimits(gifFrames(1, 1).subarray(0, 27)), false);
    assert.equal(withinBrandImageLimits(gifFrames(1, 1, 0)), false);
    const extended = gifFrames(1, 1);
    const graphicsControl = Buffer.from([33, 249, 4, 1, 0, 0, 0, 0]);
    assert.equal(withinBrandImageLimits(Buffer.concat([extended.subarray(0, 19), graphicsControl, extended.subarray(19)])), true);
});

function tiffPages(pages, littleEndian = true) {
    const stride = 2 + 4 * 12 + 4;
    const data = Buffer.alloc(8 + pages.length * stride + 12);
    const short = (value, offset) => (littleEndian ? data.writeUInt16LE(value, offset) : data.writeUInt16BE(value, offset));
    const long = (value, offset) => (littleEndian ? data.writeUInt32LE(value, offset) : data.writeUInt32BE(value, offset));
    data.write(littleEndian ? "II" : "MM");
    short(42, 2);
    long(8, 4);
    pages.forEach(([width, height, tileWidth = width, tileHeight = height], page) => {
        const offset = 8 + page * stride;
        short(4, offset);
        [256, 257, 322, 323].forEach((tag, index) => {
            const start = offset + 2 + index * 12;
            short(tag, start);
            short(4, start + 2);
            long(1, start + 4);
            long([width, height, tileWidth, tileHeight][index], start + 8);
        });
        long(page + 1 < pages.length ? offset + stride : 0, offset + stride - 4);
    });
    return data;
}

test("TIFF image admission checks every linked page and combined raster pixels in both byte orders", () => {
    const limits = { maxSide: 4, maxPixels: 16 };
    for (const littleEndian of [true, false]) {
        assert.equal(withinBrandImageLimits(tiffPages([[4, 4]], littleEndian), limits), true);
        assert.equal(
            withinBrandImageLimits(
                tiffPages(
                    [
                        [2, 2],
                        [3, 4],
                    ],
                    littleEndian,
                ),
                limits,
            ),
            true,
        );
        assert.equal(
            withinBrandImageLimits(
                tiffPages(
                    [
                        [1, 1],
                        [5, 1],
                    ],
                    littleEndian,
                ),
                limits,
            ),
            false,
        );
        assert.equal(
            withinBrandImageLimits(
                tiffPages(
                    [
                        [1, 1],
                        [4, 4],
                    ],
                    littleEndian,
                ),
                limits,
            ),
            false,
        );
        assert.equal(
            withinBrandImageLimits(
                tiffPages(
                    [
                        [1, 1],
                        [65535, 65535],
                    ],
                    littleEndian,
                ),
                limits,
            ),
            false,
        );
    }
});

test("TIFF admission bounds independent tile buffers even when pages fit", () => {
    const limits = { maxSide: 4, maxPixels: 16 };
    assert.equal(withinBrandImageLimits(tiffPages([[1, 1, 4, 4]]), limits), true);
    assert.equal(withinBrandImageLimits(tiffPages([[1, 1, 5, 1]]), limits), false);
    assert.equal(withinBrandImageLimits(tiffPages([[1, 1, 0, 1]]), limits), false);
    assert.equal(
        withinBrandImageLimits(
            tiffPages([
                [1, 1, 4, 4],
                [1, 1, 1, 1],
            ]),
            limits,
        ),
        false,
    );
});

test("TIFF admission rejects cyclic or truncated directories and bounds page metadata", () => {
    assert.equal(withinBrandImageLimits(tiffPages(Array.from({ length: 256 }, () => [1, 1]))), true);
    assert.equal(withinBrandImageLimits(tiffPages(Array.from({ length: 257 }, () => [1, 1]))), false);
    const cyclic = tiffPages([[1, 1]]);
    cyclic.writeUInt32LE(8, 58);
    assert.equal(withinBrandImageLimits(cyclic), false);
    const truncated = tiffPages([
        [1, 1],
        [1, 1],
    ]);
    assert.equal(withinBrandImageLimits(truncated.subarray(0, 115)), false);
    const invalidPointer = tiffPages([[1, 1]]);
    invalidPointer.writeUInt32LE(0xfffffffc, 58);
    assert.equal(withinBrandImageLimits(invalidPointer), false);
    const hugeValues = tiffPages([[1, 1]]);
    hugeValues.writeUInt16LE(305, 34);
    hugeValues.writeUInt32LE(0xffffffff, 38);
    assert.equal(withinBrandImageLimits(hugeValues), false);
});

function jpegFrame(width, height, marker = 192) {
    const frame = Buffer.from([255, 216, 255, marker, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 255, 217]);
    frame.writeUInt16BE(height, 7);
    frame.writeUInt16BE(width, 9);
    return frame;
}

function jpegTiff(pages) {
    const UTIF = require("utif2");
    let offset = 4096;
    const bodies = [];
    const directories = pages.map(({ jpeg, compression = 7, tables, strips = 1, interchange }) => {
        const directory = {
            t256: [1],
            t257: [strips],
            t258: [8, 8, 8],
            t259: [compression],
            t262: [2],
            t273: Array(strips).fill(offset),
            t277: [3],
            t278: [1],
            t279: Array(strips).fill(jpeg.length),
            t284: [1],
        };
        if (tables) directory.t347 = Array.from(tables);
        if (interchange !== undefined) directory.t513 = [interchange];
        bodies.push(jpeg);
        offset += jpeg.length;
        return directory;
    });
    const prefix = Buffer.from(UTIF.encode(directories));
    assert.ok(prefix.length < 4096);
    const data = Buffer.alloc(offset);
    prefix.copy(data);
    let start = 4096;
    for (const body of bodies) {
        body.copy(data, start);
        start += body.length;
    }
    return data;
}

test("TIFF JPEG admission checks embedded dimensions in modern and legacy strips", () => {
    const limits = { maxSide: 4, maxPixels: 16 };
    for (const compression of [6, 7, 34892]) {
        assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(4, 4), compression }]), limits), true);
        assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(5, 1), compression }]), limits), false);
        assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(1, 5), compression }]), limits), false);
        assert.equal(
            withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(2, 2), compression }]), {
                maxSide: 1,
                maxPixels: 1,
            }),
            false,
        );
    }
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(2, 2) }, { jpeg: jpegFrame(3, 4) }]), limits), true);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(2, 2) }, { jpeg: jpegFrame(4, 4) }]), limits), false);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(4, 4, 195) }]), limits), true);
    const legacyBody = Buffer.concat([Buffer.alloc(4), jpegFrame(4, 4)]);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: legacyBody, compression: 6, interchange: 4 }]), limits), true);
    assert.equal(
        withinBrandImageLimits(jpegTiff([{ jpeg: legacyBody, compression: 6, interchange: 4 }]), {
            maxSide: 1,
            maxPixels: 1,
        }),
        false,
    );
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: legacyBody, compression: 6, interchange: 0xffffffff }]), limits), false);
});

test("TIFF JPEG admission checks shared tables before strips", () => {
    const limits = { maxSide: 4, maxPixels: 16 };
    const tables = Buffer.from([255, 216, 255, 217]);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(4, 4), tables }]), limits), true);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(5, 1), tables }]), limits), false);
    const oversizedFrameTables = Buffer.concat([jpegFrame(5, 1).subarray(0, 15), Buffer.from([255, 217])]);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(1, 1), tables: oversizedFrameTables }]), limits), false);
});

test("TIFF JPEG admission rejects malformed headers and excessive component allocation", () => {
    const frame = jpegFrame(1, 1);
    for (const [offset, value] of [
        [6, 0],
        [6, 17],
        [11, 0],
        [11, 5],
        [13, 0],
        [13, 81],
    ]) {
        const invalid = Buffer.from(frame);
        invalid[offset] = value;
        assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: invalid }])), false);
    }
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: jpegFrame(1, 0) }])), false);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: frame.subarray(0, 20) }])), false);
    const malformedLength = Buffer.from(frame);
    malformedLength.writeUInt16BE(1, 4);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: malformedLength }])), false);
});

test("TIFF JPEG admission shares an encoded byte ceiling across repeated source strips", () => {
    const padded = Buffer.alloc(262144);
    jpegFrame(1, 1).copy(padded);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: padded, strips: 32 }])), true);
    assert.equal(withinBrandImageLimits(jpegTiff([{ jpeg: padded, strips: 33 }])), false);
});

function tiffPayloads(pages) {
    const UTIF = require("utif2");
    const { deflateSync } = require("node:zlib");
    let offset = 4096;
    const bodies = [];
    const directories = pages.map(
        ({ width = 1, height = 1, bits = 8, samples = 3, compression = 8, payloads = [Buffer.from([255, 0, 0])], encoded, repeat = 1, rows = height, tileWidth, tileHeight }) => {
            const offsets = [];
            const lengths = [];
            for (const payload of payloads) {
                const body = encoded ?? ([8, 32946].includes(compression) ? deflateSync(payload) : payload);
                offsets.push(...Array(repeat).fill(offset));
                lengths.push(...Array(repeat).fill(body.length));
                bodies.push(body);
                offset += body.length;
            }
            const directory = {
                t256: [width],
                t257: [height],
                t258: Array(samples).fill(bits),
                t259: [compression],
                t262: [2],
                t277: [samples],
                t278: [rows],
                t284: [1],
            };
            if (tileWidth !== undefined)
                Object.assign(directory, {
                    t322: [tileWidth],
                    t323: [tileHeight],
                    t324: offsets,
                    t325: lengths,
                });
            else Object.assign(directory, { t273: offsets, t279: lengths });
            return directory;
        },
    );
    const prefix = Buffer.from(UTIF.encode(directories));
    assert.ok(prefix.length < 4096);
    const data = Buffer.alloc(offset);
    prefix.copy(data);
    let start = 4096;
    for (const body of bodies) {
        body.copy(data, start);
        start += body.length;
    }
    return data;
}

test("TIFF Deflate admission stops expansion at the decoder destination capacity", () => {
    for (const compression of [8, 32946]) {
        assert.equal(withinBrandImageLimits(tiffPayloads([{ compression }]), { maxSide: 1, maxPixels: 1 }), true);
        assert.equal(withinBrandImageLimits(tiffPayloads([{ compression, payloads: [Buffer.alloc(12)] }])), false);
        assert.equal(withinBrandImageLimits(tiffPayloads([{ compression, payloads: [Buffer.alloc(4)] }])), false);
        assert.equal(withinBrandImageLimits(tiffPayloads([{ compression, payloads: [Buffer.alloc(4096)] }])), false);
    }
});

test("TIFF admission bounds byte allocations implied by sample depth and count", () => {
    const limits = { maxSide: 1, maxPixels: 1 };
    assert.equal(withinBrandImageLimits(tiffPayloads([{ bits: 16, samples: 4, payloads: [Buffer.alloc(8)] }]), limits), true);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ bits: 32, samples: 3, payloads: [Buffer.alloc(12)] }]), limits), false);
    for (const [bits, samples] of [
        [0, 3],
        [33, 3],
        [8, 9],
    ]) {
        assert.equal(withinBrandImageLimits(tiffPayloads([{ bits, samples }])), false);
    }
    assert.equal(withinBrandImageLimits(tiffPayloads([{ bits: 32, samples: 4, compression: 1, payloads: [Buffer.alloc(16)] }]), { maxSide: 1, maxPixels: 2 }), true);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ bits: 32, samples: 4, compression: 1, payloads: [Buffer.alloc(16)] }]), limits), false);
});

test("TIFF Deflate admission checks each strip against its remaining page capacity", () => {
    const page = { height: 2, rows: 1, payloads: [Buffer.alloc(3), Buffer.alloc(3)] };
    assert.equal(withinBrandImageLimits(tiffPayloads([page])), true);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ ...page, payloads: [Buffer.alloc(3), Buffer.alloc(4)] }])), false);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ height: 1, rows: 0 }])), false);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ height: 1, payloads: [Buffer.alloc(3), Buffer.alloc(3)] }])), false);
});

test("TIFF Deflate admission bounds tile output separately from the smaller page", () => {
    const page = { tileWidth: 2, tileHeight: 2, payloads: [Buffer.alloc(12)] };
    const limits = { maxSide: 2, maxPixels: 4 };
    assert.equal(withinBrandImageLimits(tiffPayloads([page]), limits), true);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ ...page, payloads: [Buffer.alloc(13)] }]), limits), false);
    assert.equal(withinBrandImageLimits(tiffPayloads([{ ...page, bits: 32, samples: 8 }]), limits), false);
});

test("TIFF admission shares raster byte ceilings across linked pages", () => {
    const page = { bits: 32, samples: 4, payloads: [Buffer.alloc(16)] };
    const limits = { maxSide: 4, maxPixels: 4 };
    assert.equal(withinBrandImageLimits(tiffPayloads([page, page]), limits), true);
    assert.equal(withinBrandImageLimits(tiffPayloads([page, page, page]), limits), false);
});

test("TIFF Deflate admission rejects unfinished streams and shares encoded bytes with JPEG", () => {
    assert.equal(withinBrandImageLimits(tiffPayloads([{ encoded: Buffer.alloc(7) }])), false);
    const padded = Buffer.alloc(262144);
    jpegFrame(1, 1).copy(padded);
    const jpegPage = { compression: 7, height: 32, rows: 1, payloads: [padded], repeat: 32 };
    assert.equal(withinBrandImageLimits(tiffPayloads([jpegPage])), true);
    const mixed = tiffPayloads([jpegPage, {}]);
    assert.ok(mixed.length < 1048576);
    assert.equal(withinBrandImageLimits(mixed), false);
});
