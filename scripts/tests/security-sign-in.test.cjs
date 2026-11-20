const { test } = require("node:test");
const assert = require("node:assert/strict");
const { StubError, loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");

function legacyCodesRoute({ recentMfa }) {
    const issued = [];
    const routes = loadRoutes("src/api/routes/users/@me/mfa/codes.ts", {
        bcrypt: { compare: async (password) => password === "correct" },
        "@spacebar/api/util": {
            requireMfa: async () => {
                if (!recentMfa) throw new StubError("Two factor is required for this operation", 401);
            },
        },
        "@spacebar/database": {
            User: { findOneOrFail: async () => ({ data: { hash: "hash" } }) },
            BackupCode: {
                update: async () => undefined,
                find: async () => {
                    issued.push("existing");
                    return [{ code: "abcdef12", consumed: false, expired: false }];
                },
            },
            generateMfaBackupCodes: () => {
                issued.push("fresh");
                return [{ code: "12345678", consumed: false, expired: false, save: async () => undefined }];
            },
        },
        "@spacebar/util": { FieldErrors: (fields) => new StubError(JSON.stringify(fields)) },
    });
    return { handler: routes["POST /"], issued };
}

test("the legacy backup codes route needs a second factor on top of the password", async () => {
    for (const regenerate of [false, true]) {
        const { handler, issued } = legacyCodesRoute({ recentMfa: false });
        const res = response();
        await assert.rejects(handler({ user_id: "1", body: { password: "correct", regenerate }, t: (key) => key }, res), /Two factor is required/);
        assert.deepEqual(issued, []);
        assert.equal(res.body, undefined);
    }
    const { handler, issued } = legacyCodesRoute({ recentMfa: true });
    const res = response();
    await handler({ user_id: "1", body: { password: "correct", regenerate: false }, t: (key) => key }, res);
    assert.deepEqual(issued, ["existing"]);
    assert.equal(res.body.backup_codes[0].code, "abcdef12");
});

function mfaWithStoredFailures() {
    const rows = new Map();
    const checked = [];
    const backupQuery = { execute: async () => ({ affected: 0 }) };
    backupQuery.update = () => backupQuery;
    backupQuery.set = () => backupQuery;
    backupQuery.where = () => backupQuery;
    backupQuery.andWhere = () => backupQuery;
    const mfa = loadModule("src/api/util/utility/mfa.ts", {
        bcrypt: { compare: async (password) => password === "correct" },
        express: {},
        jsonwebtoken: {},
        "node-2fa": {
            verifyToken: (_, code) => {
                checked.push(code);
                return code === "123456" ? { delta: 0 } : null;
            },
        },
        typeorm: { In: (value) => value },
        "@spacebar/database": {
            BackupCode: { createQueryBuilder: () => backupQuery },
            RateLimit: {
                findOne: async ({ where }) => rows.get(where.id) ?? null,
                hit: async (id, executor_id, max, window) => {
                    const stored = rows.get(id);
                    const row = stored && stored.expires_at.getTime() > Date.now() ? stored : { id, executor_id, hits: 0, expires_at: new Date(Date.now() + window * 1000) };
                    row.hits++;
                    rows.set(id, row);
                    return row;
                },
                query: async (_sql, [id]) => {
                    const row = rows.get(id);
                    if (row?.hits > 0) row.hits--;
                    return [];
                },
            },
            SecurityKey: { count: async () => 0 },
            Session: {},
            User: { findOneOrFail: async () => ({ id: "1", mfa_enabled: true, totp_secret: "SECRET", data: { hash: "hash" } }) },
            generateMfaBackupCodes: () => [],
            getDatabase: () => null,
        },
        "@spacebar/util": { EVENT: {}, Event: {}, JwtKeypairManager: {}, UserUpdateEvent: {}, emitEvent: async () => undefined },
        "@spacebar/schemas": { PrivateUserProjection: [], UserFlags: { FLAGS: {} } },
        "./e2ee": {},
        "./phoneVerification": { PhoneVerification: {} },
        "./mfaAttempt": {},
    });
    return { mfa, rows, checked };
}

test("wrong two factor codes are capped per account across every ticket", async () => {
    const { mfa, rows, checked } = mfaWithStoredFailures();
    for (let ticket = 0; ticket < mfa.FAILED_CODE_ATTEMPTS; ticket++)
        assert.equal(await mfa.verifyMfaMethod("1", ticket % 2 ? "totp" : "backup", "000000", { typ: "login", uid: "1", n: ticket }), false);
    assert.equal(rows.get("1:failed-mfa-code").hits, mfa.FAILED_CODE_ATTEMPTS);
    const before = checked.length;
    assert.equal(await mfa.verifyMfaMethod("1", "totp", "123456", { typ: "login", uid: "1", n: "fresh" }), false);
    assert.equal(await mfa.verifyMfaMethod("1", "totp", "123456", { typ: "mfa", uid: "1" }), false);
    assert.equal(checked.length, before);
    rows.get("1:failed-mfa-code").expires_at = new Date(Date.now() - 1);
    assert.equal(await mfa.verifyMfaMethod("1", "totp", "123456", { typ: "login", uid: "1", n: "later" }), true);
});

test("a correct code before the cap is accepted and does not count as a failure", async () => {
    const { mfa, rows } = mfaWithStoredFailures();
    assert.equal(await mfa.verifyMfaMethod("1", "totp", "123456", { typ: "login", uid: "1" }), true);
    assert.equal(rows.get("1:failed-mfa-code")?.hits ?? 0, 0);
});
