/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load({ requireVerification, account }) {
    const emitted = [];
    const module = { exports: {} };
    const imports = {
        "@spacebar/database": { User: { findOneOrFail: async () => account } },
        "./Config": { Config: { get: () => ({ login: { requireVerification } }) } },
        "./ipc/Event": { emitEvent: async (event) => emitted.push(event) },
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/RequiredAction.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (id) => {
                assert.ok(id in imports, id);
                return imports[id];
            },
        },
    );
    return { ...module.exports, emitted };
}

test("only an unverified person is asked to verify, and only while a verified email is required", () => {
    const on = load({ requireVerification: true });
    assert.equal(on.requiredAction({ bot: false, verified: false }), "REQUIRE_VERIFIED_EMAIL");
    assert.equal(on.requiredAction({ bot: false, verified: true }), null);
    assert.equal(on.requiredAction({ bot: true, verified: false }), null);
    assert.equal(load({ requireVerification: false }).requiredAction({ bot: false, verified: false }), null);
});

test("open clients are told when an account has to verify and when it no longer has to", async () => {
    const held = load({ requireVerification: true, account: { id: "7", bot: false, verified: false } });
    await held.emitRequiredAction("7");
    assert.deepEqual(JSON.parse(JSON.stringify(held.emitted)), [{ event: "USER_REQUIRED_ACTION_UPDATE", user_id: "7", data: { required_action: "REQUIRE_VERIFIED_EMAIL" } }]);

    const released = load({ requireVerification: true, account: { id: "7", bot: false, verified: true } });
    await released.emitRequiredAction("7");
    assert.deepEqual(JSON.parse(JSON.stringify(released.emitted)), [{ event: "USER_REQUIRED_ACTION_UPDATE", user_id: "7", data: { required_action: null } }]);
});
