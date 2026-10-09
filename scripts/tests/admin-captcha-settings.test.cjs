const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function fixture() {
    const cfg = {
        user: { identityBlockedTerms: ["blocked", "second"] },
        general: {},
        client: {},
        register: { email: {}, dateOfBirth: {}, password: {} },
        login: {},
        defaults: { user: {} },
        passwordReset: {},
        security: {
            captcha: {
                capMode: "core",
                enabled: false,
                instance: "https://stored.example.test",
                sitekey: "stored-key",
                secret: "stored-secret",
            },
        },
        limits: {
            rate: { ip: {}, global: {}, error: {}, routes: { auth: { login: {}, register: {} } } },
            e2ee: {},
            user: {},
            guild: {},
            message: {},
            channel: {},
        },
        guild: { discovery: { hideJoinedGuilds: false } },
        externalRequests: {},
    };
    const writes = [];
    let patch;
    const module = { exports: {} };
    class HTTPError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status;
        }
    }
    const imports = {
        express: {
            Router: () => ({
                get() {},
                patch: (...args) => {
                    patch = args.at(-1);
                },
            }),
        },
        "@spacebar/util/util/LoadingScreen": require("../../dist/util/util/LoadingScreen.js"),
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/api/util": { captchaEnabled: () => false },
        "@spacebar/util": { Config: { get: () => cfg, set: async (value) => writes.push(value) } },
        "lambert-server/HTTPError": { HTTPError },
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/routes/admin/settings.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            URL,
            require: (id) => {
                assert.ok(id in imports, id);
                return imports[id];
            },
        },
    );
    return { cfg, writes, patch: (body) => patch({ body }, { json() {} }) };
}

test("core selection preserves stored credentials while selecting embedded verification", async () => {
    const { patch, writes } = fixture();
    await patch({
        captcha: { capMode: "core", secret: "" },
        limits: { channel: { allowSlowmodeBypass: false } },
        e2ee: { trustServerByDefault: true },
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].security.captcha.capMode, "core");
    assert.equal(Object.hasOwn(writes[0].security.captcha, "secret"), false);
    assert.equal(writes[0].limits.channel.allowSlowmodeBypass, false);
    assert.equal(writes[0].limits.e2ee.trustServerByDefault, true);
});

test("admin rejects incomplete standalone before persisting any settings", async () => {
    for (const missing of ["instance", "sitekey", "secret"]) {
        const { cfg, patch, writes } = fixture();
        delete cfg.security.captcha[missing];
        await assert.rejects(patch({ captcha: { capMode: "standalone" } }), (error) => error.status === 400 && /requires a server URL/.test(error.message));
        assert.equal(writes.length, 0);
    }
});

test("admin rejects unsafe standalone URL and preserves masked blank secret", async () => {
    for (const instance of ["javascript:alert(1)", "https://user:password@cap.example.test", "https://cap.example.test?secret=value", "https://cap.example.test/#fragment"]) {
        const { patch, writes } = fixture();
        await assert.rejects(patch({ captcha: { capMode: "standalone", instance } }), (error) => error.status === 400);
        assert.equal(writes.length, 0);
    }
    const { patch, writes } = fixture();
    await patch({
        captcha: {
            capMode: "standalone",
            instance: "http://127.0.0.1:3000/",
            secret: "",
        },
    });
    assert.equal(writes[0].security.captcha.instance, "http://127.0.0.1:3000");
    assert.equal(Object.hasOwn(writes[0].security.captcha, "secret"), false);
});

test("Cap configuration input templates escape stored attribute payloads", () => {
    const source = fs.readFileSync("assets/public/admin/admin.js", "utf8");
    const helpers = source.slice(source.indexOf("class Raw"), source.indexOf("const snowflakeDate"));
    const attrs = [
        ...source.matchAll(
            /<input (?:type="url" )?name="captcha\.(?:instance|sitekey)" value="\$\{s\.captcha\.(?:instance|sitekey) \?\? ""\}"(?: placeholder="https:\/\/cap\.example\.com")?\s*\/>/g,
        ),
    ].map((match) => match[0]);
    assert.equal(attrs.length, 2);
    const payload = '\" autofocus onfocus="window.injected=true"><img src=x onerror="window.injected=true">&';
    const rendered = vm.runInNewContext(helpers + "\nrenderValue(html`" + attrs.join("\n") + "`)", {
        s: { captcha: { instance: payload, sitekey: payload } },
    });
    assert.equal((rendered.match(/&quot; autofocus/g) ?? []).length, 2);
    assert.equal((rendered.match(/&lt;img/g) ?? []).length, 2);
    assert.equal(rendered.includes("<img"), false);
    assert.equal(rendered.includes('value="" autofocus'), false);
});

test("generated admin schema accepts Cap mode and slowmode booleans while rejecting invalid values", () => {
    const Ajv = require("ajv");
    const schemas = JSON.parse(fs.readFileSync("assets/schemas.json", "utf8"));
    const validate = new Ajv({ strict: false }).compile({
        ...schemas.AdminSettingsUpdateSchema,
        definitions: schemas,
    });
    assert.equal(
        validate({
            captcha: { capMode: "core" },
            limits: { channel: { allowSlowmodeBypass: false } },
            e2ee: { trustServerByDefault: true },
        }),
        true,
        JSON.stringify(validate.errors),
    );
    assert.equal(validate({ limits: { channel: { allowSlowmodeBypass: "false" } } }), false);
    assert.equal(validate({ captcha: { capMode: "invalid" } }), false);
    assert.equal(validate({ limits: { channel: { unknownSetting: true } } }), false);
});

test("loading settings validate before persistence and replace custom tips", async () => {
    const { patch, writes, cfg } = fixture();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>';
    await patch({ client: { loadingTips: ["first", "second"], loadingSvg: svg } });
    assert.deepEqual(Array.from(writes[0].client.loadingTips), ["first", "second"]);
    assert.equal(writes[0].client.loadingSvg, svg);
    await patch({ client: { loadingTips: ["replacement"] } });
    assert.deepEqual(Array.from(cfg.client.loadingTips), ["replacement"]);
    await assert.rejects(patch({ client: { loadingSvg: '<svg onload="alert(1)"/>' } }), (error) => error.code === 400);
    assert.equal(writes.length, 2);
    await patch({ client: { loadingTips: [], loadingSvg: "" } });
    assert.equal(writes[2].client.loadingSvg, null);
    assert.equal(writes[2].client.loadingTips, null);
});

test("operator identity words replace the existing list and reject malformed entries before writes", async () => {
    const { cfg, patch, writes } = fixture();
    await patch({ user: { identityBlockedTerms: ["custom"] } });
    assert.deepEqual(Array.from(cfg.user.identityBlockedTerms), ["custom"]);
    await patch({ user: { identityBlockedTerms: [] } });
    assert.deepEqual(Array.from(cfg.user.identityBlockedTerms), []);
    const savedCount = writes.length;
    for (const identityBlockedTerms of [[""], [".*"], ["two words"], ["x".repeat(65)], Array(257).fill("word")])
        await assert.rejects(patch({ user: { identityBlockedTerms } }), (error) => error.status === 400);
    assert.equal(writes.length, savedCount);
});
