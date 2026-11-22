const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadRoutes, response } = require("./helpers/route-harness.cjs");

function botRoutes(app) {
    const calls = [];
    const routes = loadRoutes("src/api/routes/applications/#application_id/bot/index.ts", {
        "@spacebar/util/util/IdentityModeration": { assertIdentityNameAllowed: () => undefined },
        "lambert-server/HTTPError": { HTTPError: StubError },
        "@spacebar/api/util": {
            requireMfaIfEnabled: async (req) => {
                if (req.body?.code !== "123456") throw new StubError("mfa required", 401);
            },
            revokeSessions: async (id) => calls.push(["revokeSessions", id]),
        },
        "@spacebar/database": {
            Application: { findOneOrFail: async () => app },
        },
        "@spacebar/util": {
            DiscordApiErrors: { ACTION_NOT_AUTHORIZED_ON_APPLICATION: new StubError("not owner", 403), OAUTH2_APPLICATION_BOT_ABSENT: new StubError("no bot") },
            FieldErrors: (fields) => new StubError(JSON.stringify(fields)),
            broadcastUserUpdate: async () => undefined,
            createAppBotUser: async () => {
                calls.push(["createAppBotUser"]);
                return { id: app.id };
            },
            generateToken: async (id) => {
                calls.push(["generateToken", id]);
                return `token-for-${id}`;
            },
            handleFile: async () => undefined,
        },
        "@spacebar/schemas": {},
    });
    return { routes, calls };
}

test("creating a bot for an application that already has one is refused instead of minting a token", async () => {
    const bot = { id: "app", data: {}, save: async () => undefined };
    const { routes, calls } = botRoutes({ id: "app", owner: { id: "owner" }, owner_id: "owner", bot });
    const res = response();
    await assert.rejects(routes["POST /"]({ params: { application_id: "app" }, user_id: "owner", body: {} }, res), /already has a bot/);
    assert.deepEqual(calls, []);
    assert.equal(res.body, undefined);
});

test("resetting a bot token ends the bot's sessions before issuing the new token", async () => {
    const bot = { id: "app", data: {}, save: async () => calls.push(["save"]) };
    const { routes, calls } = botRoutes({ id: "app", owner_id: "owner", bot });
    const res = response();
    await routes["POST /reset"]({ params: { application_id: "app" }, user_id: "owner", body: { code: "123456" }, t: (key) => key }, res);
    assert.deepEqual(calls, [["save"], ["revokeSessions", "app"], ["generateToken", "app"]]);
    assert.equal(res.body.token, "token-for-app");
});

test("an application without a bot still gets one from its owner", async () => {
    const { routes, calls } = botRoutes({ id: "app", owner: { id: "owner" }, owner_id: "owner" });
    const res = response();
    await routes["POST /"]({ params: { application_id: "app" }, user_id: "owner", body: {} }, res);
    assert.deepEqual(calls, [["createAppBotUser"], ["generateToken", "app"]]);
    assert.equal(res.body.token, "token-for-app");
});
