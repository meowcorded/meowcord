const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const jwt = require("jsonwebtoken");
const { loadFederatedAdmin } = require("./federated-admin-module.cjs");
class HTTPError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
function load(file, imports) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync(file, "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            Buffer,
            process,
            Date,
            console: { error() {} },
            require(name) {
                if (name in imports) return imports[name];
                if (name.startsWith("node:") || name === "jsonwebtoken") return require(name);
                throw new Error(name);
            },
        },
    );
    return module.exports;
}
function tokenFixture() {
    const user = {
        id: "target",
        disabled: false,
        deleted: false,
        account_standing: null,
        data: { valid_tokens_since: new Date(0) },
    };
    const reads = [];
    let sessions = 0;
    const util = load("src/util/util/Token.ts", {
        "lambert-server/HTTPError": { HTTPError },
        typeorm: { MoreThan: (value) => value },
        "@spacebar/schemas": { AccountStandingState: { SUSPENDED: 500 } },
        "@spacebar/database": {
            User: {
                findOne: async (options) => {
                    reads.push(options);
                    return user;
                },
                findOneOrFail: async () => user,
            },
            Session: {
                create() {
                    sessions++;
                    throw new Error("must not create session");
                },
            },
            OAuth2Token: {
                findOne: async () => ({ user, scopes: [], id: "oauth", created_at: new Date() }),
            },
            InstanceBan: { hasInstanceBans: async () => false },
        },
        "@spacebar/extensions": {},
        "./Config": {
            Config: { get: () => ({ security: { jwtSecret: "isolated-regression-secret" } }) },
        },
        "@spacebar/util": {
            OrmUtils: { keysToObject: (keys) => Object.fromEntries(keys.map((key) => [key, true])) },
        },
        "@spacebar/util/util/ProcessLifecycle": { ProcessLifecycle: {} },
        "./StaffRoles": { isStaffAccount: () => false, loadStaffRoles: async () => ({}) },
    });
    const token = jwt.sign({ id: user.id, iat: Math.floor(Date.now() / 1000) }, "isolated-regression-secret");
    return {
        util,
        user,
        token,
        reads,
        get sessions() {
            return sessions;
        },
    };
}
test("already cryptographically cached tokens reject persisted suspension; reversal restores access", async () => {
    const f = tokenFixture();
    await f.util.checkToken(f.token);
    f.user.account_standing = 500;
    await assert.rejects(f.util.checkToken(f.token), (error) => error.code === 401);
    assert.equal(f.reads.at(-1).select.account_standing, true);
    f.user.account_standing = 100;
    await f.util.checkToken(f.token);
    f.user.disabled = true;
    await assert.rejects(f.util.checkToken(f.token));
});
test("OAuth bearer access rejects suspension and survives reversal", async () => {
    const f = tokenFixture();
    await f.util.checkOAuth2Token("Bearer opaque-isolated-token");
    f.user.account_standing = 500;
    await assert.rejects(f.util.checkOAuth2Token("Bearer opaque-isolated-token"), (error) => error.code === 401);
    f.user.account_standing = null;
    await f.util.checkOAuth2Token("Bearer opaque-isolated-token");
});
test("MFA/reset/conditional token issuance and compact token issuance cannot bypass suspension", async () => {
    const f = tokenFixture();
    f.user.account_standing = 500;
    await assert.rejects(f.util.generateToken(f.user.id), (error) => error.code === 403);
    await assert.rejects(f.util.generateCompactToken(f.user.id), (error) => error.code === 403);
    assert.equal(f.sessions, 0);
});
test("admin suspension deletes only target sessions and emits invalidation before notices; no account/history deletion", async () => {
    const user = { id: "target", rights: "0", disabled: false, account_standing: null };
    const actions = [];
    let handler;
    const database = {
        User: {
            findOneOrFail: async () => user,
            update: async (where, update) => {
                assert.equal(where.id, "target");
                Object.assign(user, update);
                actions.push("update");
            },
        },
        Session: {
            find: async ({ where }) => {
                assert.equal(String(where.user_id.in), "target");
                return [{ session_id: "one" }, { session_id: "two" }];
            },
            delete: async ({ user_id }) => {
                assert.equal(String(user_id.in), "target");
                actions.push("delete-sessions");
            },
        },
    };
    const utilities = {
        Rights: class {
            has() {
                return false;
            }
        },
        emitEvent: async (event) => actions.push(event.event),
        broadcastUserUpdate: async () => {},
    };
    const { endUserSessions } = load("src/api/util/utility/accountRemoval.ts", {
        typeorm: { In: (values) => ({ in: values }) },
        "@spacebar/database": database,
        "@spacebar/util": utilities,
        "@spacebar/schemas": {},
        "./adminTargets": { isProtectedStaffTarget: () => false },
        "./staffDisable": { staffDisableColumns: () => ({ disabled: true }) },
    });
    const util = load("src/api/routes/admin/users/#user_id/index.ts", {
        "@spacebar/util/util/IdentityModeration": load("src/util/util/IdentityModeration.ts", {
            "./Config": { Config: { get: () => ({ user: {} }) } },
            "./SlurMatcher": require("../../src/util/util/SlurMatcher.ts"),
            "./FieldError": {
                FieldErrors: (fields) => Object.assign(new HTTPError("Invalid identity", 400), { fields }),
            },
        }),
        express: {
            Router: () => ({
                get() {},
                patch(...args) {
                    handler = args.at(-1);
                },
            }),
        },
        "lambert-server/HTTPError": { HTTPError },
        "@spacebar/api/middlewares": { route: () => () => {} },
        "@spacebar/database": database,
        "@spacebar/util": utilities,
        "@spacebar/schemas": {
            AccountStandingState: { SUSPENDED: 500 },
            PrivateUserProjection: ["id"],
        },
        typeorm: {},
        "@spacebar/api/util": {
            hasAdminPanelAccess: () => false,
            currentStanding: async () => user.account_standing ?? 100,
            notifyStandingDrop: async () => actions.push("notice"),
            endUserSessions,
            withStaffDisabled: (flags) => flags,
        },
        "../index": { ADMIN_USER_COLUMNS: ["id"], pickAdminUser: (user) => user, assertCanManage: () => undefined },
        "@spacebar/api/util/utility/federatedAdmin": loadFederatedAdmin(HTTPError),
    });
    assert.ok(util.default);
    await handler(
        {
            body: { account_standing: 500 },
            params: { user_id: "target" },
            user_id: "admin",
            rights: { has: () => true },
        },
        { json() {} },
    );
    assert.equal(user.account_standing, 500);
    assert.equal(user.disabled, false);
    assert.deepEqual(actions.slice(0, 5), ["update", "delete-sessions", "SB_SESSION_REMOVE", "SB_SESSION_REMOVE", "notice"]);
    await assert.rejects(
        handler(
            {
                body: { account_standing: 500 },
                params: { user_id: "target" },
                user_id: "target",
                rights: { has: () => true },
            },
            {},
        ),
        (error) => error.code === 400,
    );
});
test("existing gateway session-remove listener closes active socket with invalid-session opcode", async () => {
    const sent = [];
    const gateway = load("src/gateway/listener/listener.ts", {
        picocolors: {},
        "@spacebar/database": {},
        "@spacebar/schemas": { ChannelType: {} },
        typeorm: {},
        "@spacebar/util": {
            Permissions: class {
                static DEFAULT_DM_PERMISSIONS = {};
            },
        },
        "../util": {
            OPCODES: { Invalid_Session: 9 },
            CLOSECODES: { Invalid_session: 4006 },
            Send: async (_socket, payload) => sent.push(payload),
        },
        "../opcodes/LazyRequest": {},
    });
    const socket = {
        user_id: "target",
        session_id: "one",
        sequence: 0,
        permissions: {},
        close(code) {
            sent.push(code);
        },
    };
    await gateway.consume.call(socket, { session_id: "one", event: "SB_SESSION_REMOVE" });
    assert.equal(sent[0].op, 9);
    assert.equal(sent[1], 4006);
});
test("valid unauthenticated webhook token cannot send for suspended owner; reversal preserves webhook", async () => {
    const user = { id: "target", account_standing: 500 };
    const webhook = { id: "hook", token: "fixture-token", user_id: user.id };
    const api = load("src/api/util/handlers/Webhook.ts", {
        "lambert-server/HTTPError": { HTTPError },
        typeorm: {},
        "./Message": {},
        "./Interaction": {},
        "../utility/polls": {},
        "../utility/tokenEquals": require("../../dist/api/util/utility/tokenEquals.js"),
        "@spacebar/database": {
            User: { findOne: async () => user },
            Webhook: { findOne: async () => webhook },
        },
        "@spacebar/util": { Snowflake: { generate: () => "fixture-message" } },
        "@spacebar/schemas": { AccountStandingState: { SUSPENDED: 500 } },
    });
    await assert.rejects(api.executeWebhook({ body: {}, params: { webhook_id: webhook.id, webhook_token: webhook.token }, query: {} }, {}), (error) => error.code === 403);
    user.account_standing = 100;
    await api.assertWebhookOwnerActive(webhook);
    assert.equal(webhook.token, "fixture-token");
});
