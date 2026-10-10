const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function harness() {
    const records = [],
        locks = [];
    let creates = 0,
        transactions = 0,
        settings = 0,
        next = 1000;
    const User = { create: (value) => value };
    const UserSettings = { create: (value) => ({ id: String(++next), ...value }) };
    const repository = {
        findOne: async ({ where }) => records.find((user) => user.id === where.id),
        find: async ({ where }) => records.filter((user) => user.username === where.username && user.bot === where.bot).sort((a, b) => a.created_at - b.created_at),
        save: async (user) => {
            creates++;
            records.push(user);
            return user;
        },
        update: async (where, value) =>
            Object.assign(
                records.find((u) => u.id === where.id),
                value,
            ),
    };
    const database = {
        transaction: async (fn) => {
            transactions++;
            await new Promise((r) => setImmediate(r));
            return fn({
                query: async (sql, args) => {
                    locks.push([sql, args]);
                },
                getRepository: (entity) =>
                    entity === User
                        ? repository
                        : {
                              save: async () => {
                                  settings++;
                              },
                          },
            });
        },
    };
    const imports = {
        "@spacebar/database": { User, UserSettings, getDatabase: () => database },
        "@spacebar/util": {
            Config: { get: () => ({ general: { instanceName: "Fixture instance" } }) },
            Rights: { FLAGS: { SEND_MESSAGES: 1n, SELF_ADD_REACTIONS: 2n, BYPASS_RATE_LIMITS: 4n } },
            Snowflake: { generate: () => String(++next) },
        },
        "@spacebar/schemas": { UserFlags: { FLAGS: { SYSTEM: 8n, VERIFIED_BOT: 16n } } },
        "../handlers/Message": {},
        "../handlers/DirectMessage": {},
        "./systemEncryption": {},
        "./e2ee": {},
    };
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/util/utility/systemAccounts.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) => (name === "@spacebar/database/Sql" ? require("../../dist/database/Sql.js") : imports[name]),
            console: { log: () => {} },
            setImmediate,
        },
    );
    return {
        api: module.exports,
        records,
        locks,
        counts: () => ({ creates, transactions, settings }),
    };
}
test("40 concurrent first official lookups share one creation and transaction-scoped database lock", async () => {
    const h = harness();
    const users = await Promise.all(Array.from({ length: 40 }, () => h.api.getSystemAccount("official")));
    assert.equal(new Set(users.map((u) => u.id)).size, 1);
    assert.deepEqual(h.counts(), { creates: 1, transactions: 1, settings: 1 });
    assert.match(h.locks[0][0], /pg_advisory_xact_lock/);
    assert.equal(h.locks[0][1][0], "system-account:official");
    await h.api.getSystemAccount("official");
    assert.equal(h.counts().creates, 1);
});
test("the oldest marked system account wins over unmarked lookalikes without changing its identity", async () => {
    const h = harness();
    h.records.push(
        { id: "123", username: "official", bot: false, flags: 0, created_at: new Date(0) },
        { id: "124", username: "official", bot: false, flags: 8, created_at: new Date(1) },
        { id: "125", username: "official", bot: false, flags: 8, created_at: new Date(2) },
    );
    const user = await h.api.getSystemAccount("official");
    assert.equal(user.id, "124");
    assert.equal(h.counts().creates, 0);
    assert.equal(user.flags, 8);
    assert.equal(user.system, true);
});
test("official and appeals creations remain separate concurrent flights", async () => {
    const h = harness();
    const [official, appeals] = await Promise.all([h.api.getSystemAccount("official"), h.api.getSystemAccount("appeals")]);
    assert.notEqual(official.id, appeals.id);
    assert.equal(official.system, true);
    assert.equal(appeals.bot, true);
    assert.equal(h.counts().creates, 2);
    assert.deepEqual(h.locks.map(([, args]) => args[0]).sort(), ["system-account:appeals", "system-account:official"]);
});
