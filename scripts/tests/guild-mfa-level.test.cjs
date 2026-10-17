/* SPDX-License-Identifier: AGPL-3.0-only */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function harness({ ownerId = "owner-1", actorId = "owner-1", ownerMfa = true, actorMfa = true, recentMfa = true, manageGuildsRight = false, initialMfaLevel = 0 } = {}) {
    const emitted = [];
    const auditLogs = [];
    const rightsBypasses = [];
    let saved = false;

    const guild = {
        id: "123456789",
        owner_id: ownerId,
        mfa_level: initialMfaLevel,
        name: "Test Guild",
        emojis: [],
        roles: [],
        stickers: [],
        save: async () => {
            saved = true;
        },
        toJSON: () => ({
            id: guild.id,
            name: guild.name,
            owner_id: guild.owner_id,
            mfa_level: guild.mfa_level,
            template_id: "stale-template",
        }),
    };

    const resolvedActorMfa = actorId === ownerId ? ownerMfa : actorMfa;
    const users = new Map([
        [ownerId, { id: ownerId, mfa_enabled: ownerMfa }],
        [actorId, { id: actorId, mfa_enabled: resolvedActorMfa }],
    ]);

    const rights = {
        has: (right) => (right === "MANAGE_GUILDS" ? manageGuildsRight : false),
    };

    let handler = null;

    const imports = {
        express: {
            Router: () => ({
                post: (_, ...steps) => {
                    handler = steps.at(-1);
                },
            }),
        },
        "@spacebar/api/middlewares": {
            route: () => (req, res, next) => next?.(),
        },
        "@spacebar/database": {
            Guild: {
                findOne: async ({ where }) => (where.id === guild.id ? guild : null),
            },
            User: {
                findOneOrFail: async ({ where }) => {
                    const user = users.get(where.id);
                    if (!user) throw Object.assign(new Error(`User not found: ${where.id}`), { code: 10011, status: 404 });
                    return user;
                },
            },
            AuditLog: {
                log: async (log) => auditLogs.push(log),
                diff: (before, after, keys) => {
                    const changes = [];
                    for (const key of keys) {
                        if (before[key] !== after[key]) {
                            changes.push({ key, old_value: before[key], new_value: after[key] });
                        }
                    }
                    return changes;
                },
            },
        },
        "@spacebar/util": {
            DiscordApiErrors: {
                UNKNOWN_GUILD: Object.assign(new Error("Unknown Guild"), { code: 10004, status: 404 }),
                MISSING_PERMISSIONS: Object.assign(new Error("Missing Permissions"), { code: 50013, status: 403 }),
                INVALID_FORM_BODY: Object.assign(new Error("Invalid Form Body"), { code: 50035, status: 400 }),
                TWO_FACTOR_REQUIRED: Object.assign(new Error("Two factor is required for this operation"), { code: 60003, status: 403 }),
            },
            emitEvent: async (event) => emitted.push(event),
            getRights: async () => rights,
        },
        "@spacebar/schemas": {
            AuditLogEvents: { GUILD_UPDATE: 1 },
            GuildMFALevel: { NONE: 0, ELEVATED: 1 },
        },
        "@spacebar/api/util": {
            noteRightsBypass: async (req, right) => rightsBypasses.push({ userId: req.user_id, right }),
            requireMfa: async () => {
                if (!recentMfa) {
                    const err = Object.assign(new Error("Two factor is required for this operation"), { code: 60003, status: 401 });
                    throw err;
                }
            },
        },
    };

    const module = { exports: {} };
    const source = fs.readFileSync("src/api/routes/guilds/#guild_id/mfa.ts", "utf8");
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;

    vm.runInNewContext(transpiled, {
        module,
        exports: module.exports,
        require: (name) => {
            if (!(name in imports)) throw new Error(`Missing mocked import: ${name}`);
            return imports[name];
        },
        console,
    });

    const invoke = async (guildId, body) => {
        let statusCode = 200;
        let responseData = null;

        const req = {
            params: { guild_id: guildId },
            body,
            user_id: actorId,
            headers: { "x-audit-log-reason": "tested mfa" },
        };
        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (data) => {
                responseData = JSON.parse(JSON.stringify(data));
                return res;
            },
        };

        await handler(req, res);
        return { status: statusCode, body: responseData };
    };

    return { invoke, guild, emitted, auditLogs, rightsBypasses, isSaved: () => saved };
}

function compilePermissions() {
    const compile = (source, imports = {}) => {
        const module = { exports: {} };
        vm.runInNewContext(
            ts.transpileModule(source, {
                compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
            }).outputText,
            {
                module,
                exports: module.exports,
                Date,
                Buffer,
                require: (name) => {
                    assert.ok(name in imports, name);
                    return imports[name];
                },
            },
        );
        return module.exports;
    };
    const bits = compile(fs.readFileSync("src/util/util/BitField.ts", "utf8"));
    const DiscordApiErrors = {
        MISSING_ACCESS: Object.assign(new Error("Missing Access"), { code: 50001, status: 403 }),
        MISSING_PERMISSIONS: Object.assign(new Error("Missing Permissions"), { code: 50013, status: 403 }),
        TWO_FACTOR_REQUIRED: Object.assign(new Error("Two factor is required for this operation"), { code: 60003, status: 403 }),
    };
    const entities = {
        Application: {},
        Member: class {},
        User: {},
        Role: class {},
        Guild: {},
        Channel: class {},
        ThreadMember: class {},
    };
    const { getPermission, Permissions } = compile(fs.readFileSync("src/util/util/Permissions.ts", "utf8"), {
        "../../database/entities": entities,
        "./BitField": bits,
        "lambert-server/HTTPError": { HTTPError: class extends Error {} },
        "./Constants": { DiscordApiErrors },
        "@spacebar/schemas": {
            ChannelType: { GUILD_PRIVATE_THREAD: 12 },
            ChannelPermissionOverwriteType: { role: 0, member: 1 },
            UserFlags: { FLAGS: { QUARANTINED: 1n } },
        },
        typeorm: { ArrayContains: () => ({}), EntityNotFoundError: class extends Error {} },
        "@spacebar/util": {
            OrmUtils: { keysToObject: (list) => Object.fromEntries(list.map((key) => [key, true])) },
        },
    });
    return { Permissions, getPermission, DiscordApiErrors, entities };
}

test("POST /guilds/:id/mfa fails when guild does not exist", async () => {
    const { invoke } = harness();
    await assert.rejects(
        () => invoke("non-existent-guild", { level: 1 }),
        (err) => err.code === 10004 && err.status === 404,
    );
});

test("POST /guilds/:id/mfa fails when caller is not the owner and lacks MANAGE_GUILDS", async () => {
    const { invoke } = harness({ ownerId: "owner-1", actorId: "intruder" });
    await assert.rejects(
        () => invoke("123456789", { level: 1 }),
        (err) => err.code === 50013,
    );
});

test("POST /guilds/:id/mfa fails when level is invalid", async () => {
    const { invoke } = harness();
    await assert.rejects(
        () => invoke("123456789", { level: 5 }),
        (err) => err.code === 50035,
    );
});

test("POST /guilds/:id/mfa rejects level 1 when owner does not have 2FA enabled", async () => {
    const { invoke } = harness({ ownerMfa: false });
    await assert.rejects(
        () => invoke("123456789", { level: 1 }),
        (err) => err.code === 60003,
    );
});

test("POST /guilds/:id/mfa requires recent MFA verification", async () => {
    const { invoke } = harness({ ownerMfa: true, recentMfa: false });
    await assert.rejects(
        () => invoke("123456789", { level: 1 }),
        (err) => err.code === 60003 && err.status === 401,
    );
});

test("POST /guilds/:id/mfa updates mfa_level to 1 and emits GUILD_UPDATE", async () => {
    const { invoke, guild, emitted, auditLogs, isSaved } = harness({ ownerMfa: true, recentMfa: true, initialMfaLevel: 0 });
    const res = await invoke("123456789", { level: 1 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { level: 1 });
    assert.equal(guild.mfa_level, 1);
    assert.equal(isSaved(), true);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].event, "GUILD_UPDATE");
    assert.equal(emitted[0].guild_id, "123456789");
    assert.equal(emitted[0].data.mfa_level, 1);
    assert.equal(emitted[0].data.template_id, undefined);

    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].action_type, 1);
    assert.equal(auditLogs[0].reason, "tested mfa");
    assert.deepEqual(auditLogs[0].changes, [{ key: "mfa_level", old_value: 0, new_value: 1 }]);
});

test("POST /guilds/:id/mfa updates mfa_level to 0", async () => {
    const { invoke, guild, emitted, isSaved } = harness({ ownerMfa: true, recentMfa: true, initialMfaLevel: 1 });
    const res = await invoke("123456789", { level: 0 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { level: 0 });
    assert.equal(guild.mfa_level, 0);
    assert.equal(isSaved(), true);
    assert.equal(emitted[0].data.mfa_level, 0);
});

test("POST /guilds/:id/mfa allows MANAGE_GUILDS operator to bypass owner check", async () => {
    const { invoke, guild, rightsBypasses } = harness({
        ownerId: "owner-1",
        actorId: "operator-admin",
        manageGuildsRight: true,
        ownerMfa: true,
        actorMfa: true,
        recentMfa: true,
    });
    const res = await invoke("123456789", { level: 1 });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { level: 1 });
    assert.equal(guild.mfa_level, 1);
    assert.equal(rightsBypasses.length, 1);
    assert.equal(rightsBypasses[0].right, "MANAGE_GUILDS");
});

test("POST /guilds/:id/mfa rejects level 1 when operator has 2FA enabled but owner does not", async () => {
    const { invoke } = harness({
        ownerId: "owner-1",
        actorId: "operator-admin",
        manageGuildsRight: true,
        ownerMfa: false,
        actorMfa: true,
        recentMfa: true,
    });
    await assert.rejects(
        () => invoke("123456789", { level: 1 }),
        (err) => err.code === 60003,
    );
});

test("POST /guilds/:id/mfa allows operator to update mfa_level to 1 when owner has 2FA enabled even if operator lacks 2FA", async () => {
    const { invoke, guild } = harness({
        ownerId: "owner-1",
        actorId: "operator-admin",
        manageGuildsRight: true,
        ownerMfa: true,
        actorMfa: false,
        recentMfa: false,
    });
    const res = await invoke("123456789", { level: 1 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { level: 1 });
    assert.equal(guild.mfa_level, 1);
});

test("Permissions.assertMfa allows non-elevated actions without 2FA in mfa_level: 1 guilds", () => {
    const { Permissions } = compilePermissions();
    const perm = new Permissions(Permissions.FLAGS.SEND_MESSAGES | Permissions.FLAGS.VIEW_CHANNEL);
    perm.cache = {
        guild: { id: "guild-1", mfa_level: 1 },
        mfa_enabled: false,
    };
    assert.doesNotThrow(() => perm.assertMfa("SEND_MESSAGES"));
    assert.doesNotThrow(() => perm.assertMfa("VIEW_CHANNEL"));
});

test("Permissions.assertMfa rejects elevated actions without 2FA in mfa_level: 1 guilds", () => {
    const { Permissions, DiscordApiErrors } = compilePermissions();
    const elevated = [
        "ADMINISTRATOR",
        "KICK_MEMBERS",
        "BAN_MEMBERS",
        "MANAGE_CHANNELS",
        "MANAGE_GUILD",
        "MANAGE_MESSAGES",
        "MANAGE_ROLES",
        "MANAGE_WEBHOOKS",
        "MANAGE_EMOJIS_AND_STICKERS",
        "MANAGE_THREADS",
        "MODERATE_MEMBERS",
    ];
    for (const flag of elevated) {
        const perm = new Permissions(Permissions.FLAGS[flag]);
        perm.cache = {
            guild: { id: "guild-1", mfa_level: 1 },
            mfa_enabled: false,
        };
        assert.throws(
            () => perm.assertMfa(flag),
            (err) => err === DiscordApiErrors.TWO_FACTOR_REQUIRED && err.status === 403,
        );
    }
});

test("Permissions.assertMfa permits elevated actions with 2FA in mfa_level: 1 guilds", () => {
    const { Permissions } = compilePermissions();
    const perm = new Permissions(Permissions.FLAGS.BAN_MEMBERS);
    perm.cache = {
        guild: { id: "guild-1", mfa_level: 1 },
        mfa_enabled: true,
    };
    assert.doesNotThrow(() => perm.assertMfa("BAN_MEMBERS"));
});

test("Permissions.assertMfa permits elevated actions without 2FA in mfa_level: 0 guilds", () => {
    const { Permissions } = compilePermissions();
    const perm = new Permissions(Permissions.FLAGS.BAN_MEMBERS);
    perm.cache = {
        guild: { id: "guild-1", mfa_level: 0 },
        mfa_enabled: false,
    };
    assert.doesNotThrow(() => perm.assertMfa("BAN_MEMBERS"));
});

test("Permissions.hasThrow enforces 2FA on elevated actions in mfa_level: 1 guilds", () => {
    const { Permissions, DiscordApiErrors } = compilePermissions();
    const perm = new Permissions(Permissions.FLAGS.VIEW_CHANNEL | Permissions.FLAGS.BAN_MEMBERS);
    perm.cache = {
        guild: { id: "guild-1", mfa_level: 1 },
        mfa_enabled: false,
    };
    assert.throws(
        () => perm.hasThrow("BAN_MEMBERS"),
        (err) => err === DiscordApiErrors.TWO_FACTOR_REQUIRED,
    );
    perm.cache.mfa_enabled = true;
    assert.equal(perm.hasThrow("BAN_MEMBERS"), true);
});

test("getPermission enforces bot application owner 2FA status in mfa_level: 1 guilds", async () => {
    const { getPermission, entities, DiscordApiErrors } = compilePermissions();
    const users = {
        "bot-user": { id: "bot-user", flags: 0, mfa_enabled: false, bot: true },
        "bot-owner": { id: "bot-owner", flags: 0, mfa_enabled: false, bot: false },
    };
    entities.User.findOneOrFail = async ({ where }) => users[where.id];
    entities.Guild.findOneOrFail = async () => ({ id: "guild-1", owner_id: "other-owner", verification_level: 0, mfa_level: 1 });
    entities.Member.createQueryBuilder = () => ({
        setFindOptions: () => ({
            getOne: async () => ({
                id: "bot-user",
                guild_id: "guild-1",
                flags: 0,
                roles: [{ id: "admin-role", guild_id: "guild-1", permissions: "8" }],
            }),
        }),
    });
    entities.Application.findOne = async ({ where }) => {
        if (where.bot?.id === "bot-user" || where.bot_user_id === "bot-user") {
            return { owner: users["bot-owner"] };
        }
        return null;
    };

    const botPermsWithoutOwnerMfa = await getPermission("bot-user", "guild-1");
    assert.throws(
        () => botPermsWithoutOwnerMfa.hasThrow("BAN_MEMBERS"),
        (err) => err === DiscordApiErrors.TWO_FACTOR_REQUIRED,
    );

    users["bot-owner"].mfa_enabled = true;
    const botPermsWithOwnerMfa = await getPermission("bot-user", "guild-1");
    assert.equal(botPermsWithOwnerMfa.hasThrow("BAN_MEMBERS"), true);
});
