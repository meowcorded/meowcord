const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { OrmUtils } = require("../../dist/util/imports/OrmUtils.js");
const source = fs.readFileSync("dist/api/routes/applications/#application_id/index.js", "utf8");
const fixture = (tags = ["base", "stale", "older"]) => {
    const handlers = {};
    let saves = 0;
    const app = {
        id: "111",
        owner: { id: "owner" },
        flags: 0,
        tags: [...tags],
        assign(body) {
            OrmUtils.mergeDeep(this, body);
            return this;
        },
        async save() {
            saves++;
        },
    };
    const router = Object.fromEntries(
        ["get", "patch", "post"].map((method) => [
            method,
            (path, ...callbacks) => {
                handlers[method] = callbacks.at(-1);
            },
        ]),
    );
    const imports = {
        express: { Router: () => router },
        typeorm: {},
        "lambert-server/HTTPError": { HTTPError: Error },
        "node-2fa": {},
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/api/activities": {
            APPLICATION_EMBEDDED: 1 << 17,
            APPLICATION_EMBEDDED_RELEASED: 1 << 18,
        },
        "@spacebar/api/activities/ActivityHost": {},
        "@spacebar/api/util/handlers/Application": {
            toOwnedApplication: (app) => ({ id: app.id, tags: [...app.tags] }),
        },
        "@spacebar/database": {
            User: { findOneOrFail: async () => ({ id: "owner", totp_secret: "" }) },
            Application: {
                findOneOrFail: async () => app,
                getRepository: () => ({
                    manager: { transaction: (work) => work({ save: (entity) => entity.save() }) },
                }),
            },
        },
        "@spacebar/util": {
            FieldErrors: (fields) => Object.assign(new Error("Invalid application field"), { fields }),
            DiscordApiErrors: {
                ACTION_NOT_AUTHORIZED_ON_APPLICATION: new Error("Not application owner"),
            },
        },
        "@spacebar/api/util/handlers/ApplicationCommands": {},
        "@spacebar/api/util": { requireMfaIfEnabled: async () => undefined },
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        module,
        exports: module.exports,
        require: (name) => {
            assert.ok(name in imports, name);
            return imports[name];
        },
    });
    return {
        app,
        saves: () => saves,
        patch: async (body, user = "owner") => {
            let result;
            await handlers.patch(
                { body, user_id: user, params: { application_id: "111" } },
                {
                    json: (value) => {
                        result = value;
                        return value;
                    },
                },
            );
            return result;
        },
    };
};
test("application tag updates replace shorter lists and clear all existing tags", async () => {
    const state = fixture();
    assert.deepEqual((await state.patch({ tags: ["base"] })).tags, ["base"]);
    assert.deepEqual(Array.from(state.app.tags), ["base"]);
    assert.deepEqual((await state.patch({ tags: [] })).tags, []);
    assert.deepEqual(Array.from(state.app.tags), []);
    assert.equal(state.saves(), 2);
});
test("application tag replacement normalizes duplicates and blank entries", async () => {
    const state = fixture();
    assert.deepEqual((await state.patch({ tags: [" new ", "new", "", " other "] })).tags, ["new", "other"]);
    assert.deepEqual(Array.from(state.app.tags), ["new", "other"]);
});
test("application changes that omit tags retain the existing list", async () => {
    const state = fixture();
    assert.deepEqual((await state.patch({ description: "updated" })).tags, ["base", "stale", "older"]);
    assert.equal(state.app.description, "updated");
});
test("invalid tags and non-owner requests cannot replace or persist application tags", async () => {
    const state = fixture();
    await assert.rejects(state.patch({ tags: ["x".repeat(21)] }), /Invalid application field/);
    await assert.rejects(state.patch({ tags: [] }, "other"), /Not application owner/);
    assert.deepEqual(Array.from(state.app.tags), ["base", "stale", "older"]);
    assert.equal(state.saves(), 0);
});
