const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const express = require("express");
const { once } = require("node:events");
const { Readable } = require("node:stream");
class HTTPError extends Error {
    constructor(message, code = 400) {
        super(message);
        this.code = code;
    }
}
function load(filename, imports = {}) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
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
            process,
            console,
            setTimeout,
            clearTimeout,
            AbortController,
            AbortSignal,
            require: (name) => (name in imports ? imports[name] : require(name)),
        },
    );
    return module.exports;
}
function admission() {
    return load("src/cdn/util/downloadAdmission.ts", { "lambert-server/HTTPError": { HTTPError } });
}
async function fixture(storage, signed = false) {
    const metrics = { previews: 0, lookups: 0 };
    const noOp = (_req, _res, next) => next();
    const route = load("src/cdn/routes/attachments.ts", {
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/database": {
            Attachment: {
                findOne: async () => {
                    metrics.lookups++;
                    return metrics.attachment ?? null;
                },
            },
            CloudAttachment: {},
            getDatabase: () => null,
        },
        "@spacebar/util": {
            Config: {
                get: () => ({ security: { requestSignature: "fixture-signature", cdnSignUrls: signed } }),
            },
            isRequestSignature: (value) => value === "fixture-signature",
            extractVideoFrame: async () => {
                metrics.previews++;
                return Buffer.from("jpeg");
            },
            hasValidSignature: () => false,
            NewUrlUserSignatureData: class {},
            UrlSignResult: { fromUrl: () => null },
            Snowflake: {},
        },
        "../util": { storage, multer: { single: () => noOp }, setCacheControl: noOp },
        "../util/cloudUploads": {
            requireInternalUploadSignature: noOp,
            requireCloudUploadReservation: noOp,
            declaredCloudUploadLimit: () => 1,
        },
        "../util/uploadAdmission": { bufferedUpload: (_limit, _parser, handler) => handler },
        "../util/downloadAdmission": admission(),
    }).default;
    const app = express();
    app.use(route);
    app.use((error, _req, res, _next) => {
        if (!res.headersSent) res.status(Number(error.code) || 500).end();
        else res.destroy();
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    return {
        origin: `http://127.0.0.1:${server.address().port}`,
        metrics,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
test("download admission bounds concurrency and preview bytes with idempotent release", () => {
    const a = admission();
    const releases = Array.from({ length: 32 }, () => a.admitDownload());
    assert.throws(
        () => a.admitDownload(),
        (error) => error.code === 503,
    );
    releases[0]();
    releases[0]();
    const extra = a.admitDownload();
    assert.throws(
        () => a.admitDownload(),
        (error) => error.code === 503,
    );
    extra();
    releases.forEach((r) => r());
    const p1 = a.admitPreview(32 * 1024 * 1024);
    const p2 = a.admitPreview(32 * 1024 * 1024);
    assert.throws(
        () => a.admitPreview(1),
        (error) => error.code === 503,
    );
    assert.throws(
        () => a.admitPreview(64 * 1024 * 1024 + 1),
        (error) => error.code === 415,
    );
    for (const invalid of [NaN, Infinity, -1, 1.5])
        assert.throws(
            () => a.admitPreview(invalid),
            (error) => error.code === 502,
        );
    p1();
    p2();
});
test("stream byte accounting rejects overstated and understated storage metadata", async () => {
    for (const size of [2, 4]) {
        await assert.rejects(
            async () => {
                const inspected = await admission().inspectDownload(Readable.from([Buffer.from("abc")]), size);
                for await (const _chunk of inspected.stream) {
                }
            },
            (error) => error.code === 502,
        );
    }
});
test("FileStorage streaming opens sparse legacy-sized files without whole-file reads and closes on abort", async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "meowcord-download-"));
    const previous = process.env.STORAGE_LOCATION;
    process.env.STORAGE_LOCATION = directory;
    try {
        const filename = path.join(directory, "large.bin");
        await fsp.writeFile(filename, "hello");
        await fsp.truncate(filename, 1024 * 1024 * 1024);
        const { FileStorage } = load("src/cdn/util/FileStorage.ts");
        const storage = new FileStorage();
        storage.get = () => {
            throw new Error("Whole read forbidden");
        };
        const controller = new AbortController();
        const file = await storage.openRead("large.bin", controller.signal);
        assert.equal(file.size, 1024 * 1024 * 1024);
        const inspected = await admission().inspectDownload(file.stream, file.size);
        assert.equal(inspected.prefix.subarray(0, 5).toString(), "hello");
        assert.ok(inspected.prefix.length <= 65536);
        const closed = new Promise((resolve) => file.stream.once("close", resolve));
        file.stream.on("error", () => {});
        controller.abort();
        await closed;
        assert.equal(file.stream.closed, true);
    } finally {
        if (previous === undefined) delete process.env.STORAGE_LOCATION;
        else process.env.STORAGE_LOCATION = previous;
        await fsp.rm(directory, { recursive: true });
    }
});
test("actual attachment HTTP authorizes before storage, sanitizes HTML, supports HEAD and never uses buffered get", async () => {
    let opens = 0;
    const storage = {
        openRead: async () => {
            opens++;
            return { size: 6, stream: Readable.from([Buffer.from("<html>")]) };
        },
        get: () => {
            throw new Error("Whole read forbidden");
        },
    };
    const f = await fixture(storage, true);
    try {
        assert.equal((await fetch(`${f.origin}/1/2/test.html`)).status, 404);
        assert.equal(opens, 0);
        const response = await fetch(`${f.origin}/1/2/test.html`, {
            headers: { signature: "fixture-signature" },
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /^text\/plain/);
        assert.equal(response.headers.get("content-length"), "6");
        assert.equal(await response.text(), "<html>");
        const head = await fetch(`${f.origin}/1/2/test.html`, {
            method: "HEAD",
            headers: { signature: "fixture-signature" },
        });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
    } finally {
        await f.close();
    }
});
test("a legacy attachment file only moves to the attachment whose filename it is", async () => {
    const files = new Map([["attachments/1/9/b.png", Buffer.from("bbb")]]);
    const moves = [];
    const storage = {
        openRead: async (path) => (files.has(path) ? { size: files.get(path).length, stream: Readable.from([files.get(path)]) } : null),
        exists: async (path) => files.has(path),
        move: async (from, to) => {
            moves.push([from, to]);
            files.set(to, files.get(from));
            files.delete(from);
        },
    };
    const f = await fixture(storage);
    f.metrics.attachment = { id: "2", channel_id: "1", message_id: "9", filename: "a.png" };
    try {
        assert.equal((await fetch(`${f.origin}/1/2/b.png`)).status, 404);
        assert.deepEqual(moves, []);
        assert.ok(files.has("attachments/1/9/b.png"));
        f.metrics.attachment = { id: "3", channel_id: "1", message_id: "9", filename: "b.png" };
        const real = await fetch(`${f.origin}/1/3/b.png`);
        assert.equal(real.status, 200);
        assert.deepEqual(moves, [["attachments/1/9/b.png", "attachments/1/3/b.png"]]);
    } finally {
        await f.close();
    }
});

test("oversized video preview rejects before consuming the remaining object", async () => {
    let produced = 0;
    const mp4 = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
    const storage = {
        openRead: async () => ({
            size: 1024 * 1024 * 1024,
            stream: Readable.from(
                (async function* () {
                    produced++;
                    yield mp4;
                    produced++;
                    yield Buffer.alloc(1024);
                })(),
            ),
        }),
    };
    const f = await fixture(storage);
    try {
        const response = await fetch(`${f.origin}/1/2/test.mp4?format=jpeg`);
        assert.equal(response.status, 415);
        assert.equal(f.metrics.previews, 0);
        assert.ok(produced <= 2);
    } finally {
        await f.close();
    }
});

test("actual attachment HTTP capacity stays reserved while streams wait and abort releases all slots", async () => {
    let opens = 0;
    let closes = 0;
    let block = true;
    const storage = {
        openRead: async (_path, signal) => {
            opens++;
            const stream = block ? new Readable({ read() {} }) : Readable.from([Buffer.from("ok")]);
            stream.on("error", () => {});
            stream.once("close", () => closes++);
            signal.addEventListener("abort", () => stream.destroy(new Error("fixture abort")), {
                once: true,
            });
            return { size: 2, stream };
        },
    };
    const f = await fixture(storage);
    const controllers = Array.from({ length: 32 }, () => new AbortController());
    const requests = controllers.map((controller) => fetch(`${f.origin}/1/2/test.bin`, { signal: controller.signal }).catch(() => null));
    try {
        for (let i = 0; opens < 32 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(opens, 32);
        assert.equal((await fetch(`${f.origin}/1/2/test.bin`)).status, 503);
        assert.equal(opens, 32);
        controllers.forEach((controller) => controller.abort());
        await Promise.all(requests);
        for (let i = 0; closes < 32 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(closes, 32);
        block = false;
        const response = await fetch(`${f.origin}/1/2/test.bin`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "ok");
    } finally {
        controllers.forEach((controller) => controller.abort());
        await f.close();
    }
});
test("S3 streaming returns metadata without buffering and rejects absent lengths", async () => {
    let object = { Body: Readable.from([Buffer.from("abc")]), ContentLength: 3 };
    let options;
    class S3 {
        async getObject(_input, value) {
            options = value;
            return object;
        }
    }
    const { S3Storage } = load("src/cdn/util/S3Storage.ts", { "@aws-sdk/client-s3": { S3 } });
    const storage = new S3Storage("fixture", "fixture", "fixture", false);
    const controller = new AbortController();
    const file = await storage.openRead("test", controller.signal);
    assert.equal(file.size, 3);
    assert.equal(file.stream, object.Body);
    const combinedSignal = options.abortSignal;
    assert.equal(combinedSignal.aborted, false);
    let text = "";
    for await (const chunk of file.stream) text += chunk.toString();
    assert.equal(text, "abc");
    controller.abort();
    assert.equal(combinedSignal.aborted, true);
    object = { Body: Readable.from([Buffer.from("abc")]) };
    await assert.rejects(() => storage.openRead("test"), /metadata/);
    assert.equal(object.Body.destroyed, true);
});

test("legacy attachment fallback moves then streams the existing file", async () => {
    let moved = false;
    const paths = [];
    const storage = {
        openRead: async (value) => {
            paths.push(value);
            return moved ? { size: 3, stream: Readable.from([Buffer.from("old")]) } : null;
        },
        exists: async (value) => value === "attachments/1/99/old.txt",
        move: async (source, target) => {
            assert.equal(source, "attachments/1/99/old.txt");
            assert.equal(target, "attachments/1/2/old.txt");
            moved = true;
        },
    };
    const f = await fixture(storage);
    f.metrics.attachment = { message_id: "99", filename: "old.txt" };
    try {
        const response = await fetch(`${f.origin}/1/2/old.txt`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "old");
        assert.equal(paths.length, 2);
    } finally {
        await f.close();
    }
});
test("storage errors release capacity for subsequent downloads", async () => {
    let fail = true;
    const storage = {
        openRead: async () => {
            if (fail) throw new Error("fixture failure");
            return { size: 0, stream: Readable.from([]) };
        },
    };
    const f = await fixture(storage);
    try {
        for (let i = 0; i < 40; i++) assert.equal((await fetch(`${f.origin}/1/2/empty.bin`)).status, 500);
        fail = false;
        const response = await fetch(`${f.origin}/1/2/empty.bin`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "");
    } finally {
        await f.close();
    }
});
