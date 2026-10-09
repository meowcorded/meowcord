/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function fixture({ emailRequired = false, requireVerification = false } = {}) {
    const cfg = {
        user: {},
        general: {},
        client: {},
        register: { email: { required: emailRequired }, dateOfBirth: {}, password: {} },
        login: { requireVerification },
        defaults: { user: { verified: true } },
        passwordReset: {},
        security: { captcha: { capMode: "core" } },
        limits: { rate: { ip: {}, global: {}, error: {}, routes: { auth: { login: {}, register: {} } } }, e2ee: {}, user: {}, guild: {}, message: {}, channel: {} },
        guild: { discovery: {} },
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
        "@spacebar/util/util/LoadingScreen": {},
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
    return { writes, patch: (body) => patch({ body }, { json() {} }) };
}

test("a verified email cannot be required while sign-up does not require an email", async () => {
    const { patch, writes } = fixture();
    await assert.rejects(patch({ login: { requireVerification: true } }), (error) => error.status === 400 && /Require an email address at sign-up/.test(error.message));
    await assert.rejects(patch({ login: { requireVerification: true }, register: { email: { required: false } } }), (error) => error.status === 400);
    assert.equal(writes.length, 0);
});

test("a verified email can be required once sign-up requires an email", async () => {
    const { patch, writes } = fixture();
    await patch({ login: { requireVerification: true }, register: { email: { required: true } }, defaults: { user: { verified: false } } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].login.requireVerification, true);
    assert.equal(writes[0].register.email.required, true);
    assert.equal(writes[0].defaults.user.verified, false);
});

test("required email cannot be turned off while a verified email stays required", async () => {
    const { patch, writes } = fixture({ emailRequired: true, requireVerification: true });
    await assert.rejects(patch({ register: { email: { required: false } } }), (error) => error.status === 400);
    assert.equal(writes.length, 0);
    await patch({ general: { instanceDescription: "unrelated" } });
    await patch({ login: { requireVerification: false }, register: { email: { required: false } } });
    assert.equal(writes.length, 2);
});
