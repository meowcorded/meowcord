const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const badgeModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/api/util/utility/prideBadges.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
        exports: badgeModule.exports,
        module: badgeModule,
    },
);

const profileModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/api/util/utility/profile.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
        exports: profileModule.exports,
        module: profileModule,
        require(name) {
            if (["@spacebar/database", "@spacebar/util"].includes(name)) return {};
            throw Error(name);
        },
    },
);

const badgeSettingsModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/api/util/utility/badgeSettings.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
        exports: badgeSettingsModule.exports,
        module: badgeSettingsModule,
        require(name) {
            if (name === "@spacebar/util") return { FieldErrors: (fields) => Object.assign(Error("invalid"), { fields }) };
            if (name === "./staffBadge") return { STAFF_BADGE_ID: "1" };
            if (name === "./prideBadges") return { PRIDE_BADGES: [] };
            throw Error(name);
        },
    },
);

const harness = () => {
    let handler;
    let getHandler;
    const calls = [];
    const reads = [];
    const user = {
        id: "123",
        bio: "before",
        pronouns: "they/them",
        banner: null,
        theme_colors: [1, 2],
        accent_color: 1,
        profile_collectibles: [],
        connected_accounts: [
            { id: "shown", type: "test", name: "visible", visibility: 1, metadata_visibility: 0 },
            { id: "hidden", visibility: 0 },
        ],
        bot: false,
        premium_type: 0,
        badge_ids: [],
        email: "private@example.invalid",
        internal_secret: "must not leave entity",
        toPublicUser() {
            return {
                id: this.id,
                bio: this.bio,
                pronouns: this.pronouns,
                banner: this.banner,
                accent_color: this.accent_color,
                theme_colors: this.theme_colors,
            };
        },
        toPartialUser() {
            return this.toPublicUser();
        },
        toPrivateUser() {
            return { ...this.toPublicUser(), email: this.email };
        },
        async save() {
            calls.push({ type: "save", public: this.toPublicUser() });
        },
    };
    const exported = { exports: {} };
    const source = fs.readFileSync("src/api/routes/users/#user_id/profile.ts", "utf8");
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        exports: exported.exports,
        module: exported,
        require(name) {
            if (name === "express")
                return {
                    Router: () => ({
                        get(_path, _options, fn) {
                            getHandler = fn;
                        },
                        patch(_path, _options, fn) {
                            handler = fn;
                        },
                    }),
                };
            if (name === "typeorm") return { In: (ids) => ids };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            if (name === "@spacebar/api/util/utility/milestones") return { milestones: {}, earnedMilestoneBadges: () => [] };
            if (name === "@spacebar/database")
                return {
                    User: {
                        createQueryBuilder: (alias) => {
                            assert.equal(alias, "user");
                            const query = {
                                leftJoin(relation, alias) {
                                    assert.equal(relation, "user.connected_accounts");
                                    assert.equal(alias, "connected_accounts");
                                    return query;
                                },
                                addSelect(columns) {
                                    if (typeof columns === "string") {
                                        assert.ok(["user.pride_badges", "user.account_preferences"].includes(columns));
                                        return query;
                                    }
                                    assert.deepEqual(Array.from(columns), [
                                        "connected_accounts.id",
                                        "connected_accounts.type",
                                        "connected_accounts.name",
                                        "connected_accounts.verified",
                                        "connected_accounts.metadata_",
                                        "connected_accounts.metadata_visibility",
                                        "connected_accounts.visibility",
                                    ]);
                                    return query;
                                },
                                leftJoinAndSelect(relation, alias) {
                                    assert.equal(relation, "user.avatar_decoration");
                                    assert.equal(alias, "avatar_decoration");
                                    return query;
                                },
                                where(condition, parameters) {
                                    assert.equal(condition, "user.id = :user_id");
                                    query.userId = parameters.user_id;
                                    return query;
                                },
                                async getOneOrFail() {
                                    reads.push("user");
                                    if (query.userId === "missing") throw Error("missing user");
                                    return user;
                                },
                            };
                            return query;
                        },
                        findOneOrFail: async (options) => {
                            reads.push("user");
                            if (options.where.id === "missing") throw Error("missing user");
                            return user;
                        },
                        find: async () => {
                            reads.push("mutual-users");
                            return [{ toPartialUser: () => ({ id: "mutual", username: "Shared friend" }) }];
                        },
                    },
                    Badge: {
                        find: async () => user.fixture_badges ?? [{ id: "assigned", description: "Admin-assigned", icon: "assigned" }],
                    },
                    Member: {
                        IsInGuildOrFail: async (id, guild_id) => {
                            reads.push("guild-access");
                            if (guild_id !== "123456") throw Error("missing guild access");
                        },
                        find: async () => {
                            reads.push("memberships");
                            return [{ guild_id: "123456", nick: "visible nickname", premium_since: null }];
                        },
                        findOne: async () => {
                            reads.push("guild-member");
                            return {
                                roles: [{ id: "123456" }, { id: "role" }],
                                toPublicMember: () => ({ nick: "visible nickname" }),
                                toPublicUser: () => ({ bio: "guild bio" }),
                            };
                        },
                    },
                    Relationship: {
                        find: async ({ where }) => {
                            reads.push("friends");
                            return [{ to_id: "mutual" }, { to_id: where.from_id === "123" ? "mine-only" : "theirs-only" }];
                        },
                    },
                };
            if (name === "@spacebar/schemas")
                return {
                    RelationshipType: { FRIEND: 1 },
                    PublicUserProjection: ["id", "username"],
                    PrivateUserProjection: ["id", "bio", "pronouns", "email", "banner", "theme_colors", "accent_color"],
                };
            if (name === "@spacebar/api/util")
                return {
                    profileMetadata: (source) => source.toPublicUser(),
                    authenticatorTypes: async () => ["totp"],
                    resolveProfileCollectibles: async (_current, ids) => ids ?? [],
                    STAFF_BADGE_ID: "1",
                    ensureStaffBadge: async () => ({ icon: "staff" }),
                };
            if (name === "@spacebar/util")
                return {
                    Config: { get: () => ({ limits: { user: { maxBio: 100, maxPronouns: 20 } } }) },
                    DiscordApiErrors: { MISSING_ACCESS: new Error("missing access") },
                    FieldErrors: (fields) => new Error(Object.keys(fields).join(",")),
                    handleFile: async () => "updated-banner",
                    emitEvent: async (event) => calls.push({ type: "self", event }),
                    broadcastUserUpdate: async (id) => calls.push({ type: "broadcast", id, public: user.toPublicUser() }),
                    loadStaffRoles: async () => ({ roles: new Map(), members: new Map() }),
                    staffBadgeRole: () => null,
                    instanceName: () => "Meowcord",
                };
            if (name === "@spacebar/api/util/utility/prideBadges") return badgeModule.exports;
            if (name === "@spacebar/api/util/utility/profile") return profileModule.exports;
            if (name === "@spacebar/api/util/utility/badgeSettings") return badgeSettingsModule.exports;
            if (name === "@spacebar/api/util/handlers/Application") return {};
            throw Error(name);
        },
    });
    return {
        user,
        calls,
        reads,
        get: async (query = {}, id = "@me") => {
            let result;
            await getHandler(
                { user_id: "123", params: { user_id: id }, query },
                {
                    json: (value) => {
                        result = value;
                    },
                },
            );
            return result;
        },
        run: async (body, id = "@me") => {
            let result;
            await handler(
                { user_id: "123", params: { user_id: id }, body },
                {
                    json: (value) => {
                        result = value;
                    },
                },
            );
            return result;
        },
    };
};

test("changed banner persists before own update and public observer broadcast", async () => {
    const { run, calls } = harness();
    const response = await run({ banner: "data:image/png;base64,fixture" });
    assert.equal(response.banner, "updated-banner");
    assert.deepEqual(
        calls.map((call) => call.type),
        ["save", "self", "broadcast"],
    );
    assert.equal(calls[1].event.event, "USER_UPDATE");
    assert.equal(calls[1].event.user_id, "123");
    assert.equal(calls[1].event.data.email, "private@example.invalid");
    assert.equal(calls[1].event.data.internal_secret, undefined);
    assert.deepEqual(Array.from(calls[1].event.data.authenticator_types), ["totp"]);
    assert.equal(calls[2].public.banner, "updated-banner");
    assert.equal(calls[2].public.email, undefined);
});

test("no-op profile updates avoid expensive observer fanout", async () => {
    const { run, calls } = harness();
    await run({ bio: "before", theme_colors: [1, 2] });
    assert.deepEqual(
        calls.map((call) => call.type),
        ["save", "self"],
    );
});

test("pronoun and theme changes reach observers while unrelated values remain", async () => {
    const { run, calls, user } = harness();
    await run({ pronouns: "she/her", theme_colors: [100, 200] }, "123");
    assert.equal(user.bio, "before");
    assert.equal(calls.at(-1).type, "broadcast");
    assert.equal(calls.at(-1).public.pronouns, "she/her");
    assert.deepEqual(Array.from(calls.at(-1).public.theme_colors), [100, 200]);
});

test("invalid and unauthorized profile updates do not persist or broadcast", async () => {
    for (const [body, id] of [
        [{ bio: "x".repeat(101) }, "@me"],
        [{ pronouns: "x".repeat(21) }, "@me"],
        [{ banner: null }, "other-user"],
    ]) {
        const { run, calls } = harness();
        await assert.rejects(run(body, id));
        assert.deepEqual(calls, []);
    }
});

const mutualQuery = {
    with_mutual_guilds: "true",
    with_mutual_friends: "true",
    with_mutual_friends_count: "true",
};

test("self profile flags return empty mutual results without redundant guild or friendship reads", async () => {
    for (const id of ["@me", "123"]) {
        const { get, reads } = harness();
        const profile = await get(mutualQuery, id);
        assert.deepEqual(reads, ["user"]);
        assert.equal(profile.mutual_guilds.length, 0);
        assert.equal(profile.mutual_friends.length, 0);
        assert.equal(profile.mutual_friends_count, 0);
        assert.equal(profile.connected_accounts.length, 1);
        assert.equal(profile.connected_accounts[0].id, "shown");
        assert.equal(profile.connected_accounts[0].metadata, undefined);
        assert.equal(profile.user.email, undefined);
    }
});

test("self profile optimization retains existence checks and requested guild profile hydration", async () => {
    const { get, reads } = harness();
    const profile = await get({ ...mutualQuery, guild_id: "123456" });
    assert.deepEqual(reads, ["guild-access", "user", "guild-member"]);
    assert.equal(profile.guild_member_profile.bio, "guild bio");
    assert.deepEqual(Array.from(profile.guild_member.roles), ["role"]);
    const missing = harness();
    await assert.rejects(missing.get(mutualQuery, "missing"), /missing user/);
    assert.deepEqual(missing.reads, ["user"]);
});

test("other user mutual results retain intersection queries and public projections", async () => {
    const { get, reads } = harness();
    const profile = await get(mutualQuery, "456");
    assert.deepEqual(reads, ["user", "memberships", "memberships", "friends", "friends", "mutual-users"]);
    assert.equal(profile.mutual_guilds.length, 1);
    assert.equal(profile.mutual_guilds[0].guild_id, undefined);
    assert.equal(profile.mutual_guilds[0].id, "123456");
    assert.equal(profile.mutual_friends.length, 1);
    assert.equal(profile.mutual_friends[0].id, "mutual");
    assert.equal(profile.mutual_friends[0].email, undefined);
    assert.equal(profile.mutual_friends_count, 1);
});

test("unrequested mutual fields stay absent and perform no extra reads", async () => {
    const { get, reads } = harness();
    const profile = await get();
    assert.deepEqual(reads, ["user"]);
    assert.equal(Object.hasOwn(profile, "mutual_guilds"), false);
    assert.equal(Object.hasOwn(profile, "mutual_friends"), false);
    assert.equal(Object.hasOwn(profile, "mutual_friends_count"), false);
});

test("profile hydration keeps connection visibility, metadata visibility and decoration response boundaries", async () => {
    const { get, user } = harness();
    user.connected_accounts = [
        {
            id: "public",
            type: "test",
            name: "Visible",
            verified: true,
            visibility: 1,
            metadata_visibility: 1,
            metadata_: { public: "shown" },
            token_data: { access_token: "private" },
        },
        {
            id: "private",
            type: "test",
            name: "Hidden",
            visibility: 0,
            metadata_visibility: 1,
            metadata_: { private: "hidden" },
        },
        {
            id: "no-metadata",
            type: "test",
            name: "Visible without metadata",
            visibility: 1,
            metadata_visibility: 0,
            metadata_: { private: "hidden" },
        },
    ];
    user.avatar_decoration = { toJSON: () => ({ asset: "local-decoration", sku_id: "456" }) };
    user.toPartialUser = () => ({
        ...user.toPublicUser(),
        avatar_decoration_data: user.avatar_decoration.toJSON(),
    });
    const result = await get({}, "456");
    const accounts = JSON.parse(JSON.stringify(result.connected_accounts));
    assert.deepEqual(accounts, [
        { id: "public", type: "test", name: "Visible", verified: true, metadata: { public: "shown" } },
        { id: "no-metadata", type: "test", name: "Visible without metadata", verified: false },
    ]);
    assert.equal(result.user.avatar_decoration_data.asset, "local-decoration");
    assert.equal(JSON.stringify(result).includes("access_token"), false);
    assert.equal(JSON.stringify(result).includes("private@example.invalid"), false);
});

test("ordinary profile appends selected pride flags without replacing assigned badges or exposing the selection column", async () => {
    const h = harness();
    h.user.pride_badges = ["transgender", "rainbow"];
    h.user.badge_ids = ["assigned"];
    const response = await h.get({}, "123");
    assert.deepEqual(
        Array.from(response.badges, (badge) => badge.description),
        ["Admin-assigned", "Transgender", "Rainbow"],
    );
    assert.equal(response.user.pride_badges, undefined);
    assert.deepEqual(h.user.badge_ids, ["assigned"]);
});

test("ordinary profile removes subscription badges while preserving assigned and pride badges", async () => {
    const h = harness();
    h.user.pride_badges = ["transgender"];
    h.user.badge_ids = ["assigned", "premium_badge", "subscriber_badge", "nitro_badge"];
    h.user.fixture_badges = [
        { id: "assigned", description: "Admin-assigned", icon: "assigned" },
        { id: "premium_badge", description: "Subscription", icon: "premium_badge" },
        { id: "subscriber_badge", description: "Subscriber", icon: "subscriber_badge" },
        { id: "nitro_badge", description: "Nitro", icon: "nitro_badge" },
        {
            id: "legacy",
            description: "Legacy subscription icon",
            icon: "2ba85e8026a8614b640c2837bcdfe21b",
        },
    ];
    const response = await h.get();
    assert.deepEqual(
        Array.from(response.badges, (badge) => badge.description),
        ["Admin-assigned", "Transgender"],
    );
    assert.deepEqual(h.user.badge_ids, ["assigned", "premium_badge", "subscriber_badge", "nitro_badge"]);
});

test("guild profile rejects outsiders before reading the target profile or guild member", async () => {
    const h = harness();
    await assert.rejects(h.get({ guild_id: "999999" }, "456"), /missing guild access/);
    assert.deepEqual(h.reads, ["guild-access"]);
});

test("guild profile rejects malformed and repeated guild queries before any database read", async () => {
    for (const guild_id of ["", "private", "1".repeat(21), ["123456", "999999"], { id: "123456" }, null]) {
        const h = harness();
        await assert.rejects(h.get({ guild_id }, "456"), /guild_id/);
        assert.deepEqual(h.reads, []);
    }
});

test("guild profile checks requester membership before returning a target guild projection", async () => {
    const h = harness();
    const response = await h.get({ guild_id: "123456" }, "456");
    assert.equal(h.reads[0], "guild-access");
    assert.equal(response.guild_member.nick, "visible nickname");
    assert.equal(response.guild_member_profile.bio, "guild bio");
});

test("ordinary user profile does not require guild access or return guild projections", async () => {
    const h = harness();
    const response = await h.get({}, "456");
    assert.equal(h.reads.includes("guild-access"), false);
    assert.equal(h.reads.includes("guild-member"), false);
    assert.equal(response.guild_member, undefined);
    assert.equal(response.guild_member_profile, undefined);
});
