const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { StubError, loadModule, loadRoutes, response } = require("./helpers/route-harness.cjs");

const DISABLED = 1n << 41n;
const schemas = { UserFlags: { FLAGS: { DISABLED } } };

function verifyRoute(user) {
    const updates = [];
    const tokens = [];
    const routes = loadRoutes("src/api/routes/auth/verify/index.ts", {
        "@spacebar/api/util": {
            emitUserUpdate: async () => undefined,
            readTicket: (token) => (token === "link" ? { typ: "email_verify", uid: user.id, email: user.email } : null),
            captchaKeyFrom: () => undefined,
            checkCaptcha: async () => null,
        },
        "@spacebar/database": {
            User: {
                findOne: async () => ({ ...user }),
                update: async (where, values) => {
                    updates.push({ where, values });
                    if (where.verified === false && !user.verified) {
                        Object.assign(user, values);
                        return { affected: 1 };
                    }
                    return { affected: 0 };
                },
            },
        },
        "@spacebar/util": {
            Config: { get: () => ({ register: { requireCaptcha: false } }) },
            emitRequiredAction: async () => undefined,
            FieldErrors: (fields) => new StubError(JSON.stringify(fields)),
            generateToken: async (id) => {
                tokens.push(id);
                return `token-for-${id}`;
            },
        },
    });
    const call = async (headers = {}, user_id) => {
        const res = response();
        await routes["POST /"]({ body: { token: "link" }, headers, user_id, t: (key) => key }, res);
        return res.body;
    };
    return { call, tokens, updates };
}

test("an email verification link issues a session token only on its first use", async () => {
    const { call, tokens } = verifyRoute({ id: "1", email: "a@example.com", verified: false, mfa_enabled: false });
    const first = await call();
    assert.equal(first.token, "token-for-1");
    const second = await call();
    assert.equal(second.token, undefined);
    assert.equal(second.user_id, "1");
    assert.deepEqual([...tokens], ["1"]);
});

test("an email verification link never issues a token for an account with two factor", async () => {
    const { call, tokens } = verifyRoute({ id: "1", email: "a@example.com", verified: false, mfa_enabled: true });
    const body = await call();
    assert.equal(body.token, undefined);
    assert.deepEqual([...tokens], []);
});

test("a signed in user verifying their own email keeps their token", async () => {
    const { call, tokens } = verifyRoute({ id: "1", email: "a@example.com", verified: true, mfa_enabled: true });
    const body = await call({ authorization: "existing" }, "1");
    assert.equal(body.token, "existing");
    assert.deepEqual([...tokens], []);
});

test("the staff disabled flag survives an undelete and is set by every staff disable path", () => {
    const { isStaffDisabled, withStaffDisabled, staffDisableColumns } = loadModule("src/api/util/utility/staffDisable.ts", { "@spacebar/schemas": schemas });
    assert.equal(isStaffDisabled(0), false);
    assert.equal(isStaffDisabled(Number(DISABLED)), true);
    assert.equal(isStaffDisabled(String(DISABLED | 4n)), true);
    assert.equal(withStaffDisabled(4, true), Number(DISABLED | 4n));
    assert.equal(withStaffDisabled(Number(DISABLED | 4n), false), 4);
    assert.equal(staffDisableColumns().flags(), `flags | ${DISABLED}`);
    for (const file of ["src/api/util/utility/accountRemoval.ts", "src/api/util/utility/instanceInvites.ts"])
        assert.match(fs.readFileSync(file, "utf8"), /staffDisableColumns\(\)/, file);
    assert.match(fs.readFileSync("src/api/routes/admin/users/#user_id/index.ts", "utf8"), /withStaffDisabled\(/);
    assert.match(fs.readFileSync("src/api/routes/auth/login.ts", "utf8"), /user\.disabled && \(!undelete \|\| isStaffDisabled\(user\.flags\)\)/);
    assert.match(fs.readFileSync("src/api/routes/auth/reset.ts", "utf8"), /disabled: !!user\.disabled && isStaffDisabled\(user\.flags\)/);
});

test("a two factor login cannot undelete an account staff disabled", async () => {
    const updates = [];
    const routes = loadRoutes("src/api/routes/auth/mfa/#authenticator_type.ts", {
        "@spacebar/api/util": {
            MfaInvalidCode: () => new StubError("invalid code"),
            MfaInvalidTicket: () => new StubError("invalid ticket"),
            guardedMfaAttempt: async (_, verify) => verify(),
            isStaffDisabled: (flags) => (BigInt(flags) & DISABLED) !== 0n,
            readTicket: () => ({ typ: "login", uid: "1", undelete: true }),
            verifyMfaMethod: async () => true,
        },
        "@spacebar/database": {
            User: {
                findOneOrFail: async () => ({ id: "1", disabled: true, deleted: false, flags: String(DISABLED) }),
                update: async (...args) => updates.push(args),
            },
        },
        "@spacebar/util": { generateToken: async () => "token" },
    });
    const res = response();
    await assert.rejects(routes["POST /"]({ params: { authenticator_type: "totp" }, body: { code: "123456", ticket: "t" } }, res), /invalid ticket/);
    assert.equal(updates.length, 0);
    assert.equal(res.body, undefined);
});

function mfaModule(rateLimitHits) {
    let hits = 0;
    return loadModule("src/api/util/utility/mfa.ts", {
        bcrypt: {},
        express: {},
        jsonwebtoken: {},
        "node-2fa": { verifyToken: () => null },
        typeorm: { In: (value) => value },
        "@spacebar/database": {
            BackupCode: {},
            RateLimit: {
                findOne: async () => null,
                hit: async (id, executor, max) => {
                    hits++;
                    rateLimitHits.push({ id, executor, max });
                    return { hits, blocked: hits >= max };
                },
            },
            SecurityKey: {},
            Session: {},
            User: {},
            generateMfaBackupCodes: () => [],
            getDatabase: () => null,
        },
        "@spacebar/util": { EVENT: {}, Event: {}, JwtKeypairManager: {}, UserUpdateEvent: {}, emitEvent: async () => undefined },
        "@spacebar/schemas": { PrivateUserProjection: [], UserFlags: { FLAGS: {} } },
        "./e2ee": {},
        "./phoneVerification": { PhoneVerification: {} },
        "./mfaAttempt": {},
    });
}

test("direct two factor codes outside the ticket flow stop being checked after ten attempts", async () => {
    const calls = [];
    const { throttledCodeAttempt, DIRECT_CODE_ATTEMPTS } = mfaModule(calls);
    let verified = 0;
    const results = [];
    for (let attempt = 0; attempt < DIRECT_CODE_ATTEMPTS + 3; attempt++)
        results.push(
            await throttledCodeAttempt("1", () => {
                verified++;
                return true;
            }),
        );
    assert.equal(verified, DIRECT_CODE_ATTEMPTS);
    assert.deepEqual(results.slice(DIRECT_CODE_ATTEMPTS), [false, false, false]);
    assert.equal(calls[0].id, "1:direct-mfa-code");
    for (const file of ["src/api/routes/users/@me/mfa/totp/disable.ts", "src/api/util/utility/mfa.ts"]) {
        const source = fs.readFileSync(file, "utf8");
        assert.match(source, /throttledCodeAttempt\(req\.user_id/, file);
    }
    for (const file of [
        "src/api/routes/applications/#application_id/reset.ts",
        "src/api/routes/applications/#application_id/index.ts",
        "src/api/routes/applications/#application_id/bot/index.ts",
    ]) {
        const source = fs.readFileSync(file, "utf8");
        assert.match(source, /requireMfaIfEnabled\(req\)/, file);
        assert.doesNotMatch(source, /from "node-2fa"|totp_secret/, file);
    }
});

function assertion(flags) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const origin = "https://chat.example.com";
    const challenge = "challenge";
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([crypto.createHash("sha256").update("chat.example.com").digest(), Buffer.from([flags]), counter]);
    const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]), privateKey);
    const credential = {
        rawId: "aWQ",
        response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
    };
    const key = { public_key: publicKey.export({ format: "pem", type: "spki" }).toString(), counter: 0, save: async () => undefined };
    return { credential, key, origin, challenge };
}

test("passwordless sign in needs the authenticator to verify the user, two factor only needs presence", async () => {
    const { verifyAssertion } = mfaModule([]);
    const presenceOnly = assertion(0x01);
    assert.equal(await verifyAssertion(presenceOnly.credential, presenceOnly.challenge, presenceOnly.origin, presenceOnly.key), true);
    assert.equal(await verifyAssertion(presenceOnly.credential, presenceOnly.challenge, presenceOnly.origin, presenceOnly.key, true), false);
    const verified = assertion(0x05);
    assert.equal(await verifyAssertion(verified.credential, verified.challenge, verified.origin, verified.key, true), true);
    const finish = fs.readFileSync("src/api/routes/auth/conditional/finish.ts", "utf8");
    assert.match(finish, /guardedMfaAttempt\(ticket!, \(\) => verifyAssertion\([^)]*, key, true\)\)/);
});

test("the backup codes key hash is keyed with a server secret and bound to the user", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "secp521r1" });
    const { hashKey } = loadModule("src/api/routes/auth/verify/view-backup-codes-challenge.ts", {
        bcrypt: {},
        express: { Router: () => ({ post: () => undefined }) },
        "@spacebar/api/middlewares": { route: () => undefined },
        "@spacebar/api/util": { signTicket: () => "" },
        "@spacebar/database": { User: {} },
        "@spacebar/util": { Config: {}, Email: {}, FieldErrors: () => undefined, JwtKeypairManager: { keypair: { privateKey } }, escapeHtml: (text) => text },
    });
    const key = "deadbeef";
    assert.notEqual(hashKey(key, "1"), crypto.createHash("sha256").update(key).digest("base64url"));
    assert.notEqual(hashKey(key, "1"), hashKey(key, "2"));
    assert.equal(hashKey(" DEADBEEF ", "1"), hashKey(key, "1"));
});
