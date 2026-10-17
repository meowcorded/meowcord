/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));

const UNKNOWN_GUILD = new StubError("Unknown Guild", 10004);
const MISSING_ACCESS = new StubError("Missing Access", 50001);

function setupThemeRoutes(guildData, memberExists) {
    let savedGuild = null;
    let emittedGuildId = null;

    const routes = loadRoutes("src/api/routes/guilds/#guild_id/theme.ts", {
        "@spacebar/database": {
            Guild: {
                findOne: async ({ where }) => {
                    if (where.id !== "123") return null;
                    return {
                        id: "123",
                        theme: guildData?.theme ?? null,
                        save: async function () {
                            savedGuild = this;
                        },
                    };
                },
                emitUpdate: async (id) => {
                    emittedGuildId = id;
                },
            },
            Member: {
                findOne: async ({ where }) => {
                    if (memberExists && where.guild_id === "123" && where.id === "user_1") {
                        return { guild_id: "123", id: "user_1" };
                    }
                    return null;
                },
            },
        },
        "@spacebar/util": {
            DiscordApiErrors: {
                UNKNOWN_GUILD,
                MISSING_ACCESS,
            },
        },
        "@spacebar/schemas": {},
    });

    return {
        routes,
        getSavedGuild: () => savedGuild,
        getEmittedGuildId: () => emittedGuildId,
    };
}

test("GET /guilds/:id/theme rejects requests for non-existent guilds", async () => {
    const { routes } = setupThemeRoutes(null, true);
    await assert.rejects(routes["GET /"]({ params: { guild_id: "999" }, user_id: "user_1" }, response()), (err) => err === UNKNOWN_GUILD);
});

test("GET /guilds/:id/theme rejects users who are not members of the guild", async () => {
    const { routes } = setupThemeRoutes({ theme: null }, false);
    await assert.rejects(routes["GET /"]({ params: { guild_id: "123" }, user_id: "user_1" }, response()), (err) => err === MISSING_ACCESS);
});

test("GET /guilds/:id/theme returns the theme for guild members", async () => {
    const theme = {
        preset_id: 2,
        custom_user_theme_settings: {
            colors: ["#112233", "#445566"],
            gradient_color_stops: [0, 100],
            gradient_angle: 45,
            base_mix: 50,
        },
        enabled: true,
    };
    const { routes } = setupThemeRoutes({ theme }, true);
    const res = response();
    await routes["GET /"]({ params: { guild_id: "123" }, user_id: "user_1" }, res);
    assert.deepEqual(
        plain(res.body),
        plain({
            theme,
            preset_id: 2,
            custom_user_theme_settings: theme.custom_user_theme_settings,
            enabled: true,
        }),
    );
});

test("the theme schema refuses bad colors, stops, angles and mixes", () => {
    const Ajv = require("ajv");
    const fs = require("node:fs");
    const schemas = JSON.parse(fs.readFileSync("assets/schemas.json", "utf8"));
    const validate = new Ajv({ strict: false }).compile({
        ...schemas.GuildThemeModifySchema,
        definitions: schemas,
    });
    const body = (custom) => ({ enabled: true, preset_id: 5, custom_user_theme_settings: { colors: ["#abcdef"], gradient_color_stops: [0, 100], ...custom } });
    assert.equal(validate(body({})), true);
    for (const bad of [
        { colors: ["not-a-color"] },
        { colors: [1] },
        { colors: Array(11).fill("#abcdef") },
        { gradient_color_stops: [-10] },
        { gradient_color_stops: [200] },
        { gradient_angle: 720 },
        { base_mix: -5 },
        { extra: true },
    ])
        assert.equal(validate(body(bad)), false, JSON.stringify(bad));
    assert.equal(validate({ enabled: true, preset_id: -1 }), false);
});

test("PATCH /guilds/:id/theme saves the theme and emits a guild update", async () => {
    const { routes, getSavedGuild, getEmittedGuildId } = setupThemeRoutes({ theme: null }, true);
    const res = response();
    const custom = { colors: ["#abcdef", "#123456"], gradient_color_stops: [0, 50.5, 100], gradient_angle: 90 };
    await routes["PATCH /"]({ params: { guild_id: "123" }, user_id: "user_1", body: { enabled: true, preset_id: 5, custom_user_theme_settings: custom } }, res);

    const saved = getSavedGuild();
    assert.ok(saved);
    assert.equal(getEmittedGuildId(), "123");
    assert.deepEqual(plain(saved.theme), { enabled: true, preset_id: 5, custom_user_theme_settings: { ...custom, base_mix: 0 } });
    assert.deepEqual(plain(res.body), plain({ theme: saved.theme, preset_id: 5, custom_user_theme_settings: saved.theme.custom_user_theme_settings, enabled: true }));
});

test("getGuildExperiments provides server theme default and does not leak client experiments", () => {
    const mockConfig = {
        client: {
            experiments: {
                "2026-08-scheduled-messages": 1,
                "secret-user-experiment": 1,
            },
            guildExperiments: {
                "guild-custom": {
                    "2026-04_server_theme": 2,
                },
                "guild-disabled": {
                    "2026-04_server_theme": 0,
                },
            },
        },
    };

    const { getGuildExperiments } = loadModule("src/util/util/ApexExperiments.ts", {
        "./Config": { Config: { get: () => mockConfig } },
        "murmurhash-js/murmurhash3_gc": require("murmurhash-js/murmurhash3_gc"),
    });

    const normal = getGuildExperiments("guild-normal");
    assert.ok(normal?.assignments);
    assert.equal(normal.assignments.length, 1);
    assert.equal(normal.assignments[0][1], 1);

    const custom = getGuildExperiments("guild-custom");
    assert.ok(custom?.assignments);
    assert.equal(custom.assignments.length, 1);
    assert.equal(custom.assignments[0][1], 2);

    const disabled = getGuildExperiments("guild-disabled");
    assert.equal(disabled, undefined);
});
