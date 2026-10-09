/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { ApiError } = require("../../dist/util/util/ApiError.js");
const { DiscordApiErrors } = require("../../dist/util/util/Constants.js");

function gate(options, { requireVerification = true } = {}) {
    const module = { exports: {} };
    const imports = {
        "@spacebar/util": {
            ApiError,
            DiscordApiErrors,
            Config: { get: () => ({ login: { requireVerification } }) },
        },
        "@spacebar/database": {},
        "@spacebar/schemas": { ajv: {} },
        "bignumber.js": { BigNumber: class {} },
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/middlewares/Route.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            Set,
            require: (id) => {
                assert.ok(id in imports, id);
                return imports[id];
            },
        },
    );
    const handler = module.exports.route(options);
    return async (method, user) => {
        let passed = false;
        await handler({ method, params: {}, body: {}, isAuthenticated: !!user, user, user_id: user?.id }, {}, () => {
            passed = true;
        });
        return passed;
    };
}

const unverified = { id: "1", bot: false, verified: false };
const refusal = (error) => error instanceof ApiError && error.code === 40002 && error.httpStatus === 403;

test("an unverified account cannot write while a verified email is required", async () => {
    const request = gate({});
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) await assert.rejects(request(method, unverified), refusal);
});

test("an unverified account can still read", async () => {
    const request = gate({});
    for (const method of ["GET", "HEAD"]) assert.equal(await request(method, unverified), true);
});

test("routes that opt in stay open to an unverified account", async () => {
    assert.equal(await gate({ allowUnverified: true })("POST", unverified), true);
    assert.equal(await gate({ authentication: "optional" })("POST", unverified), true);
});

test("verified accounts, bots and tokens without a loaded verification state are not held back", async () => {
    const request = gate({});
    assert.equal(await request("POST", { id: "1", bot: false, verified: true }), true);
    assert.equal(await request("POST", { id: "1", bot: true, verified: false }), true);
    assert.equal(await request("POST", { id: "1", bot: false }), true);
});

test("nothing is refused while a verified email is not required", async () => {
    assert.equal(await gate({}, { requireVerification: false })("POST", unverified), true);
});
