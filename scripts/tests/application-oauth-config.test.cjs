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
        redirect_uris: ["https://example.com/keep", "https://example.com/remove"],
        integration_types_config: {
            0: {
                oauth2_install_params: {
                    scopes: ["bot", "applications.commands", "webhook.incoming"],
                    permissions: "8",
                },
            },
            1: { oauth2_install_params: { scopes: ["applications.commands"], permissions: "0" } },
        },
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
            toOwnedApplication: (app) => ({
                id: app.id,
                tags: [...app.tags],
                redirect_uris: [...app.redirect_uris],
                integration_types_config: JSON.parse(JSON.stringify(app.integration_types_config)),
            }),
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
        "@spacebar/api/util": { isAllowedRedirectUri: require("../../dist/api/util/utility/redirectUri.js").isAllowedRedirectUri },
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        URL,
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
test("application redirect URI replacement removes revoked endpoints", async () => {
    const state = fixture();
    const result = await state.patch({ redirect_uris: ["https://example.com/keep"] });
    assert.deepEqual(result.redirect_uris, ["https://example.com/keep"]);
    assert.deepEqual((await state.patch({ redirect_uris: [] })).redirect_uris, []);
    assert.equal(state.saves(), 2);
});
test("application install configuration replacement removes revoked scopes and contexts", async () => {
    const state = fixture();
    const result = await state.patch({
        integration_types_config: {
            0: { oauth2_install_params: { scopes: ["applications.commands"], permissions: "8" } },
        },
    });
    assert.deepEqual(result.integration_types_config, {
        0: { oauth2_install_params: { scopes: ["applications.commands"], permissions: "0" } },
    });
});
test("application redirect URI replacement deduplicates the submitted list", async () => {
    const state = fixture();
    assert.deepEqual((await state.patch({ redirect_uris: ["https://example.com/keep", "https://example.com/keep"] })).redirect_uris, ["https://example.com/keep"]);
});
test("user-only installation configuration removes guild installation settings", async () => {
    const state = fixture();
    const config = {
        1: { oauth2_install_params: { scopes: ["applications.commands"], permissions: "0" } },
    };
    assert.deepEqual((await state.patch({ integration_types_config: config })).integration_types_config, config);
});
test("empty and null installation parameters clear previously stored defaults", async () => {
    const state = fixture();
    const empty = { 0: {} };
    assert.deepEqual((await state.patch({ integration_types_config: empty })).integration_types_config, empty);
    const nullable = { 0: { oauth2_install_params: null } };
    assert.deepEqual((await state.patch({ integration_types_config: nullable })).integration_types_config, nullable);
});
test("application updates that omit OAuth settings preserve existing settings", async () => {
    const state = fixture();
    const original = JSON.parse(
        JSON.stringify({
            redirect_uris: state.app.redirect_uris,
            integration_types_config: state.app.integration_types_config,
        }),
    );
    const result = await state.patch({ description: "updated" });
    assert.deepEqual(result.redirect_uris, original.redirect_uris);
    assert.deepEqual(result.integration_types_config, original.integration_types_config);
    assert.equal(state.app.description, "updated");
});
test("invalid redirect URLs and install parameters leave OAuth settings unchanged", async () => {
    const state = fixture();
    const original = JSON.parse(
        JSON.stringify({
            redirect_uris: state.app.redirect_uris,
            integration_types_config: state.app.integration_types_config,
        }),
    );
    for (const body of [
        { redirect_uris: ["not-a-url"] },
        { integration_types_config: {} },
        {
            integration_types_config: {
                1: { oauth2_install_params: { scopes: ["bot"], permissions: "0" } },
            },
        },
        {
            integration_types_config: {
                0: { oauth2_install_params: { scopes: ["bot"], permissions: "invalid" } },
            },
        },
    ])
        await assert.rejects(state.patch(body), /Invalid application field/);
    assert.deepEqual(state.app.redirect_uris, original.redirect_uris);
    assert.deepEqual(state.app.integration_types_config, original.integration_types_config);
    assert.equal(state.saves(), 0);
});
test("non-owner application updates cannot replace OAuth settings", async () => {
    const state = fixture();
    const original = JSON.parse(
        JSON.stringify({
            redirect_uris: state.app.redirect_uris,
            integration_types_config: state.app.integration_types_config,
        }),
    );
    await assert.rejects(state.patch({ redirect_uris: [] }, "other"), /Not application owner/);
    await assert.rejects(state.patch({ integration_types_config: { 0: {} } }, "other"), /Not application owner/);
    assert.deepEqual(state.app.redirect_uris, original.redirect_uris);
    assert.deepEqual(state.app.integration_types_config, original.integration_types_config);
    assert.equal(state.saves(), 0);
});
