const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const { MessageChannel } = require("node:worker_threads");
const { buildSync } = require("esbuild");
const { chromiumPath } = require("../util/chromium.cjs");
const bundle = (contents) =>
    buildSync({
        stdin: { contents, resolveDir: process.cwd() },
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        logLevel: "silent",
    }).outputFiles[0].text;
const attachmentCode = bundle(
    'export {createAttachments} from "./client/e2ee/src/attachments"; export {encryptFile,FILE_PREFIX} from "./client/e2ee/src/files"; export {toB64u} from "./client/e2ee/src/bytes"; export {attachmentCiphertextUrl} from "./client/e2ee/src/attachmentUrl";',
);
const workerCode = bundle('import "./client/e2ee/src/sw";');
const common = {
    btoa,
    atob,
    URL,
    Buffer,
    Blob,
    Request,
    Response,
    Headers,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    crypto: webcrypto,
    console,
    setTimeout,
    clearTimeout,
};
function registry(origin) {
    const handlers = new Map();
    const navigator = {
        serviceWorker: {
            controller: {},
            addEventListener: (name, fn) => handlers.set(name, fn),
            startMessages() {},
            register: async () => ({ active: null }),
        },
    };
    const module = { exports: {} };
    vm.runInNewContext(attachmentCode, {
        ...common,
        module,
        exports: module.exports,
        navigator,
        location: { origin },
    });
    const attachments = module.exports.createAttachments();
    attachments.start();
    return { ...module.exports, attachments, message: handlers.get("message") };
}
function worker(origin, registry, ciphertext) {
    const events = new Map(),
        ports = [],
        calls = [];
    const client = { postMessage: (data, transfers) => registry.message({ data, ports: transfers }) };
    class TrackedMessageChannel extends MessageChannel {
        constructor() {
            super();
            ports.push(this.port1, this.port2);
        }
    }
    const self = {
        location: { origin },
        skipWaiting: async () => {},
        clients: { claim: async () => {}, get: async () => client, matchAll: async () => [client] },
        addEventListener: (name, fn) => events.set(name, fn),
    };
    vm.runInNewContext(workerCode, {
        ...common,
        self,
        MessageChannel: TrackedMessageChannel,
        fetch: async (url, init) => {
            calls.push({ url, credentials: init.credentials });
            return new Response(ciphertext);
        },
    });
    return {
        calls,
        close: () => ports.forEach((port) => port.close()),
        serve: async (url) => {
            let response;
            events.get("fetch")({
                request: new Request(url),
                clientId: "window",
                respondWith: (value) => {
                    response = value;
                },
            });
            return response ? await response : null;
        },
    };
}
function message(url, id = "30", channel = "10", filename = "opaque.bin") {
    return { id: "20", channel_id: channel, attachments: [{ id, filename, url, size: 19 }] };
}
async function fixture(origin) {
    const r = registry(origin);
    const raw = new Uint8Array(32).fill(7),
        iv = new Uint8Array(12).fill(8);
    const original = new Blob(["private attachment bytes"]);
    const ciphertext = await r.encryptFile(original, raw, iv);
    const payload = {
        content: "private",
        attachments: [
            {
                name: "opaque.bin",
                filename: "private.txt",
                content_type: "text/plain",
                size: original.size,
                key: r.toB64u(raw),
                iv: r.toB64u(iv),
            },
        ],
    };
    return { r, payload, original, ciphertext };
}
test("validated ciphertext URLs follow opened origin and preserve complete signed locator", () => {
    const { attachmentCiphertextUrl } = registry("https://chat.example:8443");
    for (const host of ["localhost:3290", "127.0.0.1:3290", "0.0.0.0:3290", "[::1]:3290", "fosscord.localhost:3290", "chat.example:8443"])
        assert.equal(
            attachmentCiphertextUrl(`http://${host}/attachments/10/30/opaque.bin?sig=a%2Bb&size=16#x`, "10", "opaque.bin", "https://chat.example:8443"),
            "https://chat.example:8443/attachments/10/30/opaque.bin?sig=a%2Bb&size=16#x",
        );
    assert.equal(
        attachmentCiphertextUrl("//localhost:3290/attachments/10/30/opaque.bin", "10", "opaque.bin", "http://chat.example:8080"),
        "http://chat.example:8080/attachments/10/30/opaque.bin",
    );
    assert.equal(
        attachmentCiphertextUrl("/attachments/10/30/opaque.bin?sig=x", "10", "opaque.bin", "https://chat.example"),
        "https://chat.example/attachments/10/30/opaque.bin?sig=x",
    );
    assert.equal(attachmentCiphertextUrl("http://localhost:3290/attachments/10/30/opaque%2F.bin", "10", "opaque/.bin", "https://chat.example"), null);
    const external = "https://storage.example/attachments/99/30/opaque.bin?sig=x";
    assert.equal(attachmentCiphertextUrl(external, "10", "opaque.bin", "https://chat.example"), external);
    assert.equal(
        attachmentCiphertextUrl("https://chat.example:9999/attachments/10/30/opaque.bin", "10", "opaque.bin", "https://chat.example:8443"),
        "https://chat.example:9999/attachments/10/30/opaque.bin",
    );
});
test("attachments of a conversation hosted on another instance are read through the home's media proxy", () => {
    const { attachmentCiphertextUrl } = registry("https://home.example");
    const proxied = "https://home.example/federation-media/host.example/attachments/77/30/opaque.bin?ex=1&hm=x";
    assert.equal(attachmentCiphertextUrl(proxied, "10", "opaque.bin", "https://home.example", "@77@host.example"), proxied);
    assert.equal(attachmentCiphertextUrl(proxied, "10", "opaque.bin", "https://home.example"), null);
    assert.equal(attachmentCiphertextUrl(proxied, "10", "opaque.bin", "https://home.example", "@78@host.example"), null);
    assert.equal(attachmentCiphertextUrl(proxied, "10", "opaque.bin", "https://home.example", "@77@other.example"), null);
    assert.equal(attachmentCiphertextUrl(proxied, "77", "opaque.bin", "https://home.example"), null);
    assert.equal(attachmentCiphertextUrl(proxied, "10", "other.bin", "https://home.example", "@77@host.example"), null);
});
test("actual attachment registry feeds normalized URL to actual service worker and decrypts identical bytes", async () => {
    for (const origin of ["https://chat.example:8443", "http://chat.example:8080"]) {
        const f = await fixture(origin),
            m = message("https://localhost:3290/attachments/10/30/opaque.bin?ex=1&sig=a%2Bb");
        f.r.attachments.apply(m, f.payload);
        assert.equal(m.attachments[0].url, `${origin}/e2ee/attachments/10/30/private.txt`);
        const w = worker(origin, f.r, f.ciphertext);
        try {
            const response = await w.serve(m.attachments[0].url);
            assert.equal(response.status, 200);
            assert.equal(await response.text(), await f.original.text());
            assert.deepEqual(w.calls, [{ url: `${origin}/attachments/10/30/opaque.bin?ex=1&sig=a%2Bb`, credentials: "same-origin" }]);
            assert.equal(response.headers.get("content-disposition"), "inline; filename*=UTF-8''private.txt");
        } finally {
            w.close();
        }
    }
});
test("actual registry and worker preserve unrelated external ciphertext URLs", async () => {
    const origin = "https://chat.example",
        f = await fixture(origin),
        external = "https://ciphertext.example/custom/opaque.bin?signature=external";
    const m = message(external);
    f.r.attachments.apply(m, f.payload);
    const w = worker(origin, f.r, f.ciphertext);
    try {
        const response = await w.serve(m.attachments[0].url);
        assert.equal(await response.text(), await f.original.text());
        assert.equal(w.calls[0].url, external);
    } finally {
        w.close();
    }
});
test("mismatched channel, filename and invalid local locators never enter registry or fetch worker ciphertext", async () => {
    const origin = "https://chat.example";
    for (const value of [
        "http://localhost:3290/attachments/99/30/opaque.bin",
        "http://localhost:3290/attachments/10/30/other.bin",
        "http://localhost:3290/attachments/10/30/opaque.bin/extra",
        "http://localhost:3290/attachments/10/30/%ZZ",
        "http://localhost:3290/attachments/10/30/opaque%2F.bin",
        "https://name:pass@ciphertext.example/custom/opaque.bin",
        "file://ciphertext.example/attachments/10/30/opaque.bin",
        "javascript:alert(1)",
        "http://name:pass@localhost:3290/attachments/10/30/opaque.bin",
        "http://localhost:3290/other-service/opaque.bin",
    ]) {
        const f = await fixture(origin),
            m = message(value);
        f.r.attachments.apply(m, f.payload);
        assert.equal(m.attachments[0].url, value);
        const w = worker(origin, f.r, f.ciphertext);
        try {
            const response = await w.serve(`${origin}/e2ee/attachments/10/30/private.txt`);
            assert.equal(response.status, 404);
            assert.equal(w.calls.length, 0);
        } finally {
            w.close();
        }
    }
});

test("real browser service worker fetches registered ciphertext from opened origin", { skip: process.env.E2EE_ATTACHMENT_BROWSER_TEST !== "1", timeout: 30000 }, async () => {
    const http = require("node:http");
    const path = require("node:path");
    const os = require("node:os");
    const { createRequire } = require("node:module");
    const { chromium } = createRequire(path.join(os.homedir(), ".cache/fosscord-tools/package.json"))("playwright-core");
    const js = buildSync({
        stdin: {
            contents:
                'export {createAttachments} from "./client/e2ee/src/attachments"; export {encryptFile} from "./client/e2ee/src/files"; export {toB64u} from "./client/e2ee/src/bytes";',
            resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        globalName: "AttachmentOriginFixture",
    }).outputFiles[0].text;
    const workerJs = buildSync({
        stdin: { contents: 'import "./client/e2ee/src/sw";', resolveDir: process.cwd() },
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
    }).outputFiles[0].text;
    let ciphertext;
    const received = [];
    const server = http.createServer(async (req, res) => {
        if (req.url === "/") return res.end('<script src="/fixture.js"></script>');
        if (req.url === "/fixture.js" || req.url === "/e2ee-sw.js") {
            res.setHeader("Content-Type", "application/javascript");
            return res.end(req.url === "/fixture.js" ? js : workerJs);
        }
        if (req.url === "/ciphertext-fixture" && req.method === "POST") {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            ciphertext = Buffer.concat(chunks);
            return res.end();
        }
        if (req.url === "/attachments/10/30/opaque.bin?sig=a%2Bb") {
            received.push(req.url);
            return res.end(ciphertext);
        }
        res.statusCode = 404;
        res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({
            executablePath: chromiumPath(),
            headless: true,
        });
        const context = await browser.newContext();
        const unexpected = [];
        await context.route("http://localhost:3290/**", (route) => {
            unexpected.push(route.request().url());
            return route.abort();
        });
        const page = await context.newPage();
        await page.goto(origin);
        const result = await page.evaluate(async () => {
            const fixture = window.AttachmentOriginFixture;
            const attachments = fixture.createAttachments();
            attachments.start();
            if (!(await attachments.ready())) throw Error("Fixture service worker did not control window");
            const raw = crypto.getRandomValues(new Uint8Array(32)),
                iv = crypto.getRandomValues(new Uint8Array(12));
            const original = new Blob(["synthetic encrypted fixture bytes"]);
            await fetch("/ciphertext-fixture", {
                method: "POST",
                body: await fixture.encryptFile(original, raw, iv),
            });
            const message = {
                id: "20",
                channel_id: "10",
                attachments: [
                    {
                        id: "30",
                        filename: "opaque.bin",
                        url: "http://localhost:3290/attachments/10/30/opaque.bin?sig=a%2Bb",
                    },
                ],
            };
            attachments.apply(message, {
                content: "fixture",
                attachments: [
                    {
                        name: "opaque.bin",
                        filename: "private.txt",
                        content_type: "text/plain",
                        size: original.size,
                        key: fixture.toB64u(raw),
                        iv: fixture.toB64u(iv),
                    },
                ],
            });
            const response = await fetch(message.attachments[0].url);
            return {
                status: response.status,
                text: await response.text(),
                virtualUrl: message.attachments[0].url,
            };
        });
        assert.equal(result.status, 200);
        assert.equal(result.text, "synthetic encrypted fixture bytes");
        assert.equal(result.virtualUrl, `${origin}/e2ee/attachments/10/30/private.txt`);
        assert.deepEqual(received, ["/attachments/10/30/opaque.bin?sig=a%2Bb"]);
        assert.deepEqual(unexpected, []);
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
