const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { Client } = require("pg");
const { randomBytes } = require("node:crypto");
function load(filename) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(filename, "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            require: (name) =>
                name === "@spacebar/database/Sql"
                    ? require("../../dist/database/Sql.js")
                    : name === "@spacebar/util"
                      ? {
                            CollectibleItemType: {
                                AVATAR_DECORATION: 0,
                                PROFILE_EFFECT: 1,
                                NAMEPLATE: 2,
                                PROFILE_FRAME: 3,
                            },
                            Collectibles: { setCustomSource() {} },
                        }
                      : {},
        },
    );
    return module.exports;
}
const { clearStoreSelections } = load("src/api/util/utility/store.ts");
const { StoreSelectionDeletion1791807003271 } = load("src/database/migration/postgres/1791807003271-StoreSelectionDeletion.ts");

test("store deletion clears selections and prevents stale writes in PostgreSQL", { skip: !process.env.STORE_SELECTIONS_DATABASE }, async (t) => {
    const schema = "store_selection_" + randomBytes(6).toString("hex");
    const a = new Client({ connectionString: process.env.STORE_SELECTIONS_DATABASE });
    const b = new Client({ connectionString: process.env.STORE_SELECTIONS_DATABASE });
    const manager = (client) => ({
        query: async (sql, parameters) => (await client.query(sql, parameters)).rows,
    });
    await a.connect();
    await b.connect();
    try {
        await a.query(`CREATE SCHEMA "${schema}"`);
        for (const client of [a, b]) await client.query(`SET search_path TO "${schema}"`);
        for (const table of ["users", "members"])
            await a.query(
                `CREATE TABLE "${table}" (id text PRIMARY KEY, avatar_decoration_data jsonb, collectibles jsonb, profile_collectibles jsonb, pride_badges jsonb DEFAULT '["progress"]', pronouns text DEFAULT 'they/them', flags integer DEFAULT 7)`,
            );
        await a.query("CREATE TABLE store_items (id text PRIMARY KEY)");
        const migration = new StoreSelectionDeletion1791807003271();
        const insert = async (table, id, sku) =>
            a.query(`INSERT INTO "${table}" (id, avatar_decoration_data, collectibles, profile_collectibles) VALUES ($1, $2, $3, $4)`, [
                id,
                { sku_id: sku, asset: "fixture" },
                { nameplate: { sku_id: "102", asset: "fixture" }, future: { preserved: true } },
                JSON.stringify([{ sku_id: "103", type: 1 }, { sku_id: "200", type: 3 }, null, { future: true }]),
            ]);
        await t.test("migration is idempotent and preserves recorded deletion ids", async () => {
            await migration.up(manager(a));
            await a.query("INSERT INTO store_item_deletions (sku_id) VALUES ('historic')");
            await migration.up(manager(a));
            assert.equal((await a.query("SELECT count(*)::int AS count FROM store_item_deletions")).rows[0].count, 1);
        });
        await t.test("global and server selections clear while unrelated cosmetics and pride survive", async () => {
            for (const table of ["users", "members"]) {
                await insert(table, "affected", "101");
                await a.query(`INSERT INTO "${table}" (id, avatar_decoration_data, profile_collectibles) VALUES ('malformed', '{"sku_id":"101"}', '{"future":true}')`);
                await a.query(`INSERT INTO "${table}" (id) VALUES ('empty')`);
            }
            await clearStoreSelections(manager(a), ["101", "102", "103", "101"]);
            for (const table of ["users", "members"]) {
                const row = (await a.query(`SELECT * FROM "${table}" WHERE id = 'affected'`)).rows[0];
                assert.equal(row.avatar_decoration_data, null);
                assert.equal(row.collectibles.nameplate, null);
                assert.deepEqual(row.collectibles.future, { preserved: true });
                assert.deepEqual(row.profile_collectibles, [{ sku_id: "200", type: 3 }, null, { future: true }]);
                assert.deepEqual(row.pride_badges, ["progress"]);
                assert.equal(row.pronouns, "they/them");
                assert.equal(row.flags, 7);
                const malformed = (await a.query(`SELECT * FROM "${table}" WHERE id = 'malformed'`)).rows[0];
                assert.equal(malformed.avatar_decoration_data, null);
                assert.deepEqual(malformed.profile_collectibles, { future: true });
                assert.equal((await a.query(`SELECT profile_collectibles FROM "${table}" WHERE id = 'empty'`)).rows[0].profile_collectibles, null);
            }
        });
        await t.test("failed item deletion rolls back both profile cleanup and its deletion record", async () => {
            await insert("users", "rollback", "105");
            await a.query("INSERT INTO store_items VALUES ('105')");
            await a.query("BEGIN");
            try {
                await clearStoreSelections(manager(a), ["105"]);
                await a.query("DELETE FROM store_items WHERE id = '105'");
                await assert.rejects(a.query("SELECT 1 / 0"), (error) => error.code === "22012");
            } finally {
                await a.query("ROLLBACK");
            }
            assert.equal((await a.query("SELECT avatar_decoration_data FROM users WHERE id = 'rollback'")).rows[0].avatar_decoration_data.sku_id, "105");
            assert.equal((await a.query("SELECT count(*)::int AS count FROM store_items WHERE id = '105'")).rows[0].count, 1);
            assert.equal((await a.query("SELECT count(*)::int AS count FROM store_item_deletions WHERE sku_id = '105'")).rows[0].count, 0);
        });
        await t.test("a stale profile writer waiting for deletion cannot restore the removed sku", async () => {
            await a.query("INSERT INTO users (id, avatar_decoration_data, collectibles, profile_collectibles) VALUES ('concurrent', $1, $2, $3)", [
                { sku_id: "106", asset: "fixture" },
                { nameplate: { sku_id: "107" }, future: { preserved: true } },
                JSON.stringify([{ sku_id: "108", type: 1 }, { sku_id: "200", type: 3 }, null]),
            ]);
            const original = (await a.query("SELECT * FROM users WHERE id = 'concurrent'")).rows[0];
            await a.query("BEGIN");
            await b.query("BEGIN");
            let completed = false,
                pending;
            try {
                await clearStoreSelections(manager(b), ["106", "107", "108"]);
                pending = a
                    .query("UPDATE users SET avatar_decoration_data = $1, profile_collectibles = $2, collectibles = $3, pronouns = 'updated' WHERE id = 'concurrent'", [
                        original.avatar_decoration_data,
                        JSON.stringify(original.profile_collectibles),
                        original.collectibles,
                    ])
                    .then(() => {
                        completed = true;
                    });
                await new Promise((resolve) => setTimeout(resolve, 30));
                assert.equal(completed, false);
                await b.query("COMMIT");
                await pending;
                await a.query("COMMIT");
                const current = (await a.query("SELECT * FROM users WHERE id = 'concurrent'")).rows[0];
                assert.equal(current.avatar_decoration_data, null);
                assert.equal(current.pronouns, "updated");
                assert.equal(current.collectibles.nameplate, null);
                assert.deepEqual(current.collectibles.future, { preserved: true });
                assert.deepEqual(current.profile_collectibles, [{ sku_id: "200", type: 3 }, null]);
            } finally {
                await b.query("ROLLBACK");
                if (pending) await pending.catch(() => {});
                await a.query("ROLLBACK");
            }
        });
        await t.test("later inserts cannot introduce deleted cosmetics into either profile scope", async () => {
            for (const table of ["users", "members"]) {
                await insert(table, "late", "106");
                const row = (await a.query(`SELECT * FROM "${table}" WHERE id = 'late'`)).rows[0];
                assert.equal(row.avatar_decoration_data, null);
                assert.equal(row.collectibles.nameplate, null);
                assert.deepEqual(row.profile_collectibles, [{ sku_id: "200", type: 3 }, null, { future: true }]);
            }
        });
        await t.test("migration downgrade and reapply remain idempotent", async () => {
            await migration.down(manager(a));
            await migration.down(manager(a));
            assert.equal((await a.query("SELECT to_regclass('store_item_deletions') AS name")).rows[0].name, null);
            await migration.up(manager(a));
            await migration.up(manager(a));
            assert.equal((await a.query("SELECT count(*)::int AS count FROM store_item_deletions")).rows[0].count, 0);
        });
    } finally {
        await b.query("ROLLBACK").catch(() => {});
        await a.query("ROLLBACK").catch(() => {});
        await a.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await Promise.all([a.end(), b.end()]);
    }
});
