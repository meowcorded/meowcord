const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const { OrmUtils } = require("../../dist/util/imports/OrmUtils.js");
const source = fs.readFileSync("dist/api/routes/applications/#application_id/index.js", "utf8");
const fixture = ({ fail, bot = true } = {}) => {
    const stored = {
        application: { id: "111", description: "original", tags: ["base"] },
        bot: { id: "222", bio: "original" },
    };
    const handlers = {};
    let transactions = 0;
    const writes = [];
    let inTransaction = false;
    const app = {
        ...stored.application,
        owner: { id: "owner" },
        flags: 0,
        assign(body) {
            OrmUtils.mergeDeep(this, body);
            return this;
        },
        async save() {
            writes.push({ entity: "application", inTransaction });
            if (fail === "application") throw new Error("Injected application save failure");
            stored.application.description = this.description;
        },
    };
    app.bot = bot
        ? {
              ...stored.bot,
              assign(body) {
                  OrmUtils.mergeDeep(this, body);
                  return this;
              },
              async save() {
                  writes.push({ entity: "bot", inTransaction });
                  if (fail === "bot") throw new Error("Injected bot save failure");
                  stored.bot.bio = this.bio;
              },
          }
        : null;
    const repository = {
        manager: {
            transaction: async (work) => {
                transactions++;
                const before = structuredClone(stored);
                inTransaction = true;
                try {
                    return await work({ save: (entity) => entity.save() });
                } catch (error) {
                    Object.assign(stored, before);
                    throw error;
                } finally {
                    inTransaction = false;
                }
            },
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
            toOwnedApplication: (app) => ({ id: app.id, description: app.description }),
        },
        "@spacebar/database": {
            User: { findOneOrFail: async () => ({ id: "owner", totp_secret: "" }) },
            Application: { findOneOrFail: async () => app, getRepository: () => repository },
        },
        "@spacebar/util": {
            FieldErrors: (fields) => Object.assign(new Error("Invalid application field"), { fields }),
            DiscordApiErrors: {
                ACTION_NOT_AUTHORIZED_ON_APPLICATION: new Error("Not application owner"),
            },
        },
        "@spacebar/api/util/handlers/ApplicationCommands": {},
        "@spacebar/api/util": {},
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
        stored,
        writes,
        transactions: () => transactions,
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
test("application description updates save the application and bot in one transaction", async () => {
    const state = fixture();
    assert.equal((await state.patch({ description: "updated" })).description, "updated");
    assert.equal(state.stored.application.description, "updated");
    assert.equal(state.stored.bot.bio, "updated");
    assert.equal(state.transactions(), 1);
    assert.deepEqual(state.writes, [
        { entity: "application", inTransaction: true },
        { entity: "bot", inTransaction: true },
    ]);
});
test("empty application descriptions also clear the bot biography atomically", async () => {
    const state = fixture();
    await state.patch({ description: "" });
    assert.equal(state.stored.application.description, "");
    assert.equal(state.stored.bot.bio, "");
    assert.equal(state.transactions(), 1);
});
test("omitted descriptions leave the bot biography untouched", async () => {
    const state = fixture();
    await state.patch({ name: "updated" });
    assert.equal(state.stored.application.description, "original");
    assert.equal(state.stored.bot.bio, "original");
    assert.deepEqual(state.writes, [{ entity: "application", inTransaction: true }]);
});
test("bot-less application descriptions still save in a transaction", async () => {
    const state = fixture({ bot: false });
    await state.patch({ description: "updated" });
    assert.equal(state.stored.application.description, "updated");
    assert.deepEqual(state.writes, [{ entity: "application", inTransaction: true }]);
});
test("invalid application fields reject before any application or bot metadata write", async () => {
    for (const invalid of [
        { tags: ["x".repeat(21)] },
        { custom_install_url: "not-a-url" },
        { integration_types_config: {} },
        { terms_of_service_url: "not-a-url" },
        { privacy_policy_url: "not-a-url" },
    ]) {
        const state = fixture();
        await assert.rejects(state.patch({ description: "rejected", ...invalid }), /Invalid application field/);
        assert.equal(state.stored.application.description, "original");
        assert.equal(state.stored.bot.bio, "original");
        assert.deepEqual(state.writes, []);
        assert.equal(state.transactions(), 0);
    }
});
for (const fail of ["application", "bot"])
    test(`${fail} persistence failure rolls back both metadata rows`, async () => {
        const state = fixture({ fail });
        await assert.rejects(state.patch({ description: "rejected" }), /Injected .* save failure/);
        assert.equal(state.stored.application.description, "original");
        assert.equal(state.stored.bot.bio, "original");
        assert.equal(state.transactions(), 1);
    });
test("non-owners cannot change application descriptions or bot biographies", async () => {
    const state = fixture();
    await assert.rejects(state.patch({ description: "rejected" }, "other"), /Not application owner/);
    assert.equal(state.stored.application.description, "original");
    assert.equal(state.stored.bot.bio, "original");
    assert.deepEqual(state.writes, []);
});
