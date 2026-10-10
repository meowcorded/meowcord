/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("SQLite migrates, preserves exact IDs, serializes writes, rolls back and survives reopening", { timeout: 30_000 }, async () => {
    if (process.env.SQLITE_DATABASE_TEST_CHILD !== "1") {
        const directory = mkdtempSync(path.join(tmpdir(), "meowcord-sqlite-test-"));
        try {
            writeFileSync(
                path.join(directory, "config.json"),
                JSON.stringify({
                    general: { serverName: "http://localhost:3001" },
                    api: { endpointPublic: "http://localhost:3001/api/v9" },
                    cdn: { endpointPublic: "http://localhost:3001", endpointPrivate: "http://localhost:3001" },
                    gateway: { endpointPublic: "ws://localhost:3001" },
                }),
            );
            const result = spawnSync(process.execPath, ["test", __filename], {
                env: {
                    ...process.env,
                    SQLITE_DATABASE_TEST_CHILD: "1",
                    APPLY_DB_MIGRATIONS: "true",
                    DB_LOGGING: "",
                    DATABASE: `sqlite:${path.join(directory, "database.sqlite")}`,
                    DB_SYNC: "",
                    CONFIG_PATH: path.join(directory, "config.json"),
                },
                encoding: "utf8",
                timeout: 25_000,
            });
            assert.equal(result.status, 0, result.stdout + result.stderr);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        return;
    }
    const { initDatabase, closeDatabase } = require("../../dist/database");
    const { StatusComponent, RateLimit, User, Relationship, Guild, Channel, ScheduledMessage } = require("../../dist/database/entities");
    const { sqlArrayIncludes, sqlLike, sqlReturning } = require("../../dist/database/Sql.js");
    const { ArrayContains, ArrayOverlap, ILike } = require("typeorm");
    const { Config } = require("../../dist/util/util/Config.js");
    const { InitialSqlite1791809007777 } = require("../../dist/database/migration/sqlite/1791809007777-InitialSqlite.js");
    try {
        const [database, same] = await Promise.all([initDatabase(), initDatabase()]);
        assert.equal(database, same);
        assert.equal((await database.query("PRAGMA foreign_keys"))[0].foreign_keys, 1);
        assert.equal((await database.query("SELECT count(*) AS count FROM categories"))[0].count, 49);
        assert.equal(await StatusComponent.count(), 6);
        const id = "9007199254740993";
        await StatusComponent.create({ id, name: "SQLite test" }).save();
        const component = await StatusComponent.findOneByOrFail({ id });
        assert.equal(component.id, id);
        assert.equal(component.status, "operational");
        assert.ok(component.updated_at instanceof Date);
        const migrations = await database.query("SELECT name FROM migrations");
        const runner = database.createQueryRunner();
        try {
            await new InitialSqlite1791809007777().up(runner);
        } finally {
            await runner.release();
        }
        assert.deepEqual(await database.query("SELECT name FROM migrations"), migrations);
        assert.equal(await StatusComponent.count(), 7);
        const attempts = await Promise.all(Array.from({ length: 20 }, () => RateLimit.reserve("test", "tester", 5, 60)));
        assert.equal(attempts.filter((attempt) => attempt.admitted).length, 5);
        assert.equal((await RateLimit.findOneByOrFail({ id: "test" })).hits, 5);
        await assert.rejects(
            database.transaction(async (manager) => {
                await manager.query("UPDATE rate_limits SET hits=99 WHERE id=$1", ["test"]);
                throw new Error("rollback test");
            }),
            /rollback test/,
        );
        assert.equal((await RateLimit.findOneByOrFail({ id: "test" })).hits, 5);
        await Promise.all(
            Array.from({ length: 10 }, () =>
                database.transaction(async (manager) => {
                    const [row] = await manager.query("SELECT hits FROM rate_limits WHERE id=$1", ["test"]);
                    await new Promise((resolve) => setImmediate(resolve));
                    await manager.query("UPDATE rate_limits SET hits=$2 WHERE id=$1", ["test", row.hits + 1]);
                }),
            ),
        );
        assert.equal((await RateLimit.findOneByOrFail({ id: "test" })).hits, 15);
        const membership = await database.query(`SELECT 1 AS found WHERE ${sqlArrayIncludes("$1", "$2")}`, [id, [id]]);
        assert.equal(membership.length, 1);
        assert.equal((await database.query(`SELECT 1 WHERE ${sqlLike("$1", "$2")}`, ["test%_", "%\\%\\_%"])).length, 1);
        assert.deepEqual(await database.query("SELECT '$1' AS literal, $2 AS repeated, $2 AS again", [null, "value"]), [{ literal: "$1", repeated: "value", again: "value" }]);
        assert.equal((await database.query(sqlReturning("UPDATE rate_limits SET hits=16 WHERE id=$1 RETURNING hits"), ["test"]))[0].hits, 16);
        await Config.init();
        const user = await User.register({ username: "sqlite_tester", password: "sqlite-test-only" });
        assert.equal((await User.findOneByOrFail({ id: user.id })).id, user.id);
        await assert.rejects(User.createQueryBuilder("user").setLock("pessimistic_write").getOne(), /transaction.*required|required.*transaction/);
        const friend = await User.register({ username: "sqlite%_friend", password: "sqlite-test-only" });
        await Relationship.create({ from_id: user.id, to_id: friend.id, type: 3 }).save();
        assert.equal((await Relationship.findOneByOrFail({ from_id: user.id, to_id: friend.id })).user_ignored, false);
        assert.equal((await User.findOneByOrFail({ username: ILike("sqlite\\%\\_friend") })).id, friend.id);
        const { clearStoreSelections } = require("../../dist/api/util/utility/store.js");
        const selections = {
            avatar_decoration_data: { sku_id: "101", asset: "fixture" },
            collectibles: { nameplate: { sku_id: "102", asset: "fixture" }, future: { preserved: true } },
            profile_collectibles: [{ sku_id: "103", type: 1 }, { sku_id: "200", type: 3 }, null, { future: true }],
        };
        await User.update({ id: user.id }, selections);
        await database.transaction((manager) => clearStoreSelections(manager, ["101", "102", "103"]));
        await User.update({ id: user.id }, selections);
        const cleared = await User.findOneByOrFail({ id: user.id });
        assert.equal(cleared.avatar_decoration_data, null);
        assert.deepEqual(cleared.collectibles, { nameplate: null, future: { preserved: true } });
        assert.deepEqual(cleared.profile_collectibles, [{ sku_id: "200", type: 3 }, null, { future: true }]);
        const guild = await Guild.createGuild({ name: "SQLite guild", owner_id: user.id, source_guild_id: null });
        await Guild.update({ id: guild.id }, { features: ["DISCOVERABLE", "COMMUNITY"] });
        assert.equal(await Guild.countBy({ id: guild.id, features: ArrayContains(["DISCOVERABLE", "COMMUNITY"]) }), 1);
        assert.equal(await Guild.countBy({ id: guild.id, features: ArrayContains(["DISCOVERABLE", "MISSING"]) }), 0);
        assert.equal(await Guild.countBy({ id: guild.id, features: ArrayOverlap(["MISSING", "COMMUNITY"]) }), 1);
        const channel = await Channel.findOneByOrFail({ guild_id: guild.id, type: 0 });
        const version = channel.version;
        await Channel.update({ id: channel.id }, { name: "renamed" });
        assert.ok(Number((await Channel.findOneByOrFail({ id: channel.id })).version) > Number(version));
        const { dispatchClaimedScheduledMessage } = require("../../dist/api/util/handlers/ScheduledMessageDispatch.js");
        const scheduled = await ScheduledMessage.create({ user_id: user.id, channel_id: channel.id, send_at: new Date(0), payload: { content: "SQLite delivery" } }).save();
        let deliveries = 0;
        const dispatch = () =>
            dispatchClaimedScheduledMessage(
                database.query.bind(database),
                scheduled.id,
                async (message) => {
                    assert.equal(message.payload.content, "SQLite delivery");
                    deliveries++;
                    await new Promise((resolve) => setImmediate(resolve));
                    return null;
                },
                true,
            );
        const delivered = await Promise.all([dispatch(), dispatch()]);
        assert.equal(delivered.filter(Boolean).length, 1);
        assert.equal(deliveries, 1);
        assert.equal(await ScheduledMessage.existsBy({ id: scheduled.id }), false);
        const { GuildInsights } = require("../../dist/database/insights/GuildInsights.js");
        await GuildInsights.increment(guild.id, [
            ["messages", "", 2],
            ["messages", "", 3],
        ]);
        assert.equal((await database.query("SELECT value FROM guild_insights_daily WHERE guild_id=$1 AND metric='messages'", [guild.id]))[0].value, 5);
        const { reserveMfaAttempt, consumeMfaTicket } = require("../../dist/api/util/utility/mfaAttempt.js");
        const attemptsMfa = await Promise.all(Array.from({ length: 10 }, () => reserveMfaAttempt(database, "sqlite-mfa-ticket", Date.now() + 60_000)));
        assert.equal(attemptsMfa.filter(Boolean).length, 5);
        const consumed = await Promise.all(Array.from({ length: 5 }, () => consumeMfaTicket(database, attemptsMfa.find(Boolean))));
        assert.equal(consumed.filter(Boolean).length, 1);
        const rights = BigInt((await User.findOneByOrFail({ id: user.id })).rights);
        for (const action of ["grant", "revoke"]) {
            const operator = spawnSync(process.execPath, ["scripts/ops/operator.mjs", action, user.id], { env: process.env, encoding: "utf8" });
            assert.equal(operator.status, 0, operator.stdout + operator.stderr);
            assert.equal(BigInt((await User.findOneByOrFail({ id: user.id })).rights), action === "grant" ? rights | 1n : rights & ~1n);
        }
        await Channel.deleteChannel(channel);
        assert.equal((await database.query("SELECT channel_id FROM message_purges WHERE channel_id=$1", [channel.id]))[0].channel_id, channel.id);
        assert.equal((await database.query("SELECT entity_id FROM guild_entity_deletes WHERE entity_id=$1", [channel.id]))[0].entity_id, channel.id);
        const { withE2eeMutation } = require("../../dist/api/util/utility/e2ee.js");
        await Promise.all(
            Array.from({ length: 5 }, () =>
                withE2eeMutation(user.id, async (manager, account) => {
                    account.data.sqlite_mutations = Number(account.data.sqlite_mutations ?? 0) + 1;
                    await new Promise((resolve) => setImmediate(resolve));
                    await manager.update(User, { id: user.id }, { data: account.data });
                }),
            ),
        );
        assert.equal((await User.findOne({ where: { id: user.id }, select: { data: true } })).data.sqlite_mutations, 5);
        await closeDatabase();
        const reopened = await initDatabase();
        assert.equal((await StatusComponent.findOneByOrFail({ id })).id, id);
        assert.equal((await reopened.query("SELECT COUNT(*) AS count FROM migrations"))[0].count, migrations.length);
    } finally {
        await closeDatabase();
    }
});
