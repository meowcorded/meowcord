const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { createServer } = require("node:http");
function fixture(captcha, outbound = fetch) {
    const config = {
        security: { captcha },
        register: { requireCaptcha: true },
        externalRequests: { thirdParty: false },
    };
    const module = { exports: {} };
    const source = ts.transpileModule(fs.readFileSync("src/api/util/utility/captcha.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        fetch: outbound,
        AbortSignal,
        require: (name) => {
            assert.equal(name, "@spacebar/util");
            return { Config: { get: () => config } };
        },
    });
    return module.exports;
}
test("required core signup challenges survive incomplete optional configuration without outbound requests", async () => {
    for (const config of [
        {},
        { enabled: false },
        {
            capMode: "core",
            instance: "https://stale.invalid",
            sitekey: "stale",
            secret: "stale",
        },
    ]) {
        const api = fixture(config, () => {
            throw Error("Core must stay local");
        });
        assert.equal(api.registrationCapEndpoint(), "/api/v9/auth/cap/");
        const challenge = await api.checkRegistrationCaptcha(null);
        assert.equal(challenge.captcha_service, "cap");
        assert.equal(challenge.captcha_sitekey, "fosscord");
        assert.deepEqual(Array.from(challenge.captcha_key), ["captcha-required"]);
    }
});
test("incomplete standalone signup configuration fails closed before network or token use", async () => {
    for (const missing of ["instance", "sitekey", "secret"]) {
        const config = {
            capMode: "standalone",
            instance: "http://127.0.0.1",
            sitekey: "fixture",
            secret: "fixture",
        };
        delete config[missing];
        const api = fixture(config, () => {
            throw Error("Incomplete settings must not send requests");
        });
        await assert.rejects(api.checkRegistrationCaptcha("fixture-proof"), /Cap Standalone needs/);
        assert.throws(() => api.registrationCapEndpoint(), /Cap Standalone needs/);
    }
});
test("standalone verifies required signup with optional captcha disabled and encodes the site key", async () => {
    const requests = [];
    const server = createServer(async (req, res) => {
        let text = "";
        for await (const chunk of req) text += chunk;
        requests.push({ path: req.url, method: req.method, body: JSON.parse(text) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const api = fixture({
            capMode: "standalone",
            enabled: false,
            instance: `http://127.0.0.1:${server.address().port}///`,
            sitekey: "key/with space",
            secret: "synthetic-secret",
        });
        assert.equal(api.captchaEnabled(), false);
        assert.equal(await api.checkRegistrationCaptcha("synthetic-proof"), null);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].path, "/key%2Fwith%20space/siteverify");
        assert.equal(requests[0].method, "POST");
        assert.deepEqual(requests[0].body, { secret: "synthetic-secret", response: "synthetic-proof" });
        const challenge = await api.checkRegistrationCaptcha("x".repeat(513));
        assert.equal(challenge.captcha_sitekey, "key/with space");
        assert.equal(requests.length, 1);
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
test("standalone provider failures remain required verification challenges", async () => {
    for (const outbound of [
        async () => {
            throw Error("disconnected");
        },
        async () => new Response("bad json", { status: 200 }),
        async () => Response.json({ success: true }, { status: 503 }),
        async () => Response.json({ success: false }),
    ]) {
        const api = fixture(
            {
                capMode: "standalone",
                instance: "http://127.0.0.1",
                sitekey: "fixture",
                secret: "synthetic",
            },
            outbound,
        );
        const challenge = await api.checkRegistrationCaptcha("synthetic-proof");
        assert.equal(challenge.captcha_service, "cap");
        assert.ok(challenge.captcha_key.length);
    }
});
test("a proof in X-Captcha-Key replaces the key the first attempt put in the body", () => {
    const api = fixture({});
    const request = (header, body) => ({ get: (name) => (name === "X-Captcha-Key" ? header : undefined), body });
    assert.equal(api.captchaKeyFrom(request("solved-in-dialog", { captcha_key: "rejected-first-attempt" })), "solved-in-dialog");
    assert.equal(api.captchaKeyFrom(request("solved-in-dialog", {})), "solved-in-dialog");
    assert.equal(api.captchaKeyFrom(request(undefined, { captcha_key: "solved-in-form" })), "solved-in-form");
    assert.equal(api.captchaKeyFrom(request("", { captcha_key: "solved-in-form" })), "solved-in-form");
    assert.equal(api.captchaKeyFrom(request(undefined, {})), undefined);
    assert.equal(api.captchaKeyFrom(request(undefined, undefined)), undefined);
});
