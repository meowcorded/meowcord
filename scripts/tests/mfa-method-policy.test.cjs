const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const crypto = require("node:crypto");
const ts = require("typescript");

function harness({ mfa = false, keys = 0 } = {}) {
    const user = {
        id: "actor",
        mfa_enabled: mfa,
        totp_secret: "fixture",
        data: { hash: "hash" },
        phone: "fixture-phone",
        flags: 16,
    };
    const issued = [];
    let credentialKey = null;
    const handlers = {};
    let backupConsumed = false;
    const imports = {
        "node:crypto": crypto,
        bcrypt: { compare: async (data) => data === "correct" },
        jsonwebtoken: { verify: (token) => ({ exp: Math.floor(Date.now() / 1000) + 300, ...JSON.parse(token) }), sign: (data) => JSON.stringify(data) },
        "node-2fa": { verifyToken: (_, code) => (code === "123456" ? { delta: 0 } : null) },
        typeorm: { In: (values) => values },
        "@spacebar/database": {
            getDatabase: () => ({}),
            RateLimit: { hit: async () => ({ hits: 1, blocked: false }), findOne: async () => null, query: async () => [] },
            User: {
                findOneOrFail: async () => user,
                findOne: async () => user,
                update: async (_, fields) => Object.assign(user, fields),
            },
            SecurityKey: {
                count: async () => keys,
                find: async () => Array.from({ length: keys }, () => ({})),
                findOne: async () => credentialKey,
            },
            BackupCode: {
                update: async () => {},
                createQueryBuilder: () => {
                    const criteria = {};
                    const builder = {
                        update: () => builder,
                        set: () => builder,
                        where: (_, data) => {
                            Object.assign(criteria, data);
                            return builder;
                        },
                        andWhere: (_, data) => {
                            Object.assign(criteria, data);
                            return builder;
                        },
                        execute: async () => {
                            await Promise.resolve();
                            if (criteria.user_id !== "actor" || criteria.code !== "abcdef12" || backupConsumed || criteria.expired !== false || criteria.consumed !== false)
                                return { affected: 0 };
                            backupConsumed = true;
                            return { affected: 1 };
                        },
                    };
                    return builder;
                },
            },
        },
        "@spacebar/util": {
            JwtKeypairManager: { keypair: {} },
            generateToken: async () => {
                issued.push("login");
                return "login-token";
            },
        },
        "@spacebar/schemas": { UserFlags: { FLAGS: { MFA_SMS: 16n } } },
        "./e2ee": {},
        "./mfaAttempt": { reserveMfaAttempt: async () => "fixture", consumeMfaTicket: async () => true },
        "./phoneVerification": { PhoneVerification: { verify: (_, code) => code === "sms-code" } },
        express: {
            Router: () => ({
                post: (_, ...steps) => {
                    handlers.current = steps.at(-1);
                },
            }),
        },
        "@spacebar/api/middlewares": { route: () => () => {} },
    };
    function load(path) {
        const module = { exports: {} };
        vm.runInNewContext(
            ts.transpileModule(fs.readFileSync(path, "utf8"), {
                compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2022,
                    esModuleInterop: true,
                },
            }).outputText,
            {
                module,
                exports: module.exports,
                require: (name) => {
                    if (!(name in imports)) throw new Error(name);
                    return imports[name];
                },
                Buffer,
                URL,
                Map,
                Date,
            },
        );
        return module.exports;
    }
    const shared = load("src/api/util/utility/mfa.ts");
    imports["@spacebar/api/util"] = shared;
    load("src/api/routes/auth/mfa/#authenticator_type.ts");
    const login = handlers.current;
    load("src/api/routes/mfa/finish.ts");
    const finish = handlers.current;
    imports["@spacebar/api/util"] = {
        ...shared,
        currentToken: () => "existing-token",
        emitUserUpdate: async () => {},
        setSmsFlag: async () => {},
    };
    load("src/api/routes/users/@me/mfa/totp/disable.ts");
    const disable = handlers.current;
    const response = {
        json: (body) => {
            issued.push(body);
            return response;
        },
        status: () => response,
        cookie: () => {},
    };
    return {
        shared,
        disable,
        login,
        finish,
        issued,
        response,
        setCredential: (key) => {
            credentialKey = key;
        },
    };
}

for (const state of [{ mfa: false }, { mfa: true }, { keys: 1 }]) {
    test(`login password is rejected with ${JSON.stringify(state)}`, async () => {
        const h = harness(state);
        assert.equal(
            await h.shared.verifyMfaMethod("actor", "password", "correct", {
                typ: "login",
                uid: "actor",
            }),
            false,
        );
        await assert.rejects(
            h.login(
                {
                    params: { authenticator_type: "password" },
                    body: { ticket: JSON.stringify({ typ: "login", uid: "actor" }), code: "correct" },
                },
                h.response,
            ),
            /Invalid two-factor code/,
        );
        assert.equal(h.issued.length, 0);
    });
}

test("password step-up requires current absence of all second factors", async () => {
    for (const state of [{ mfa: true }, { keys: 1 }]) {
        const h = harness(state);
        assert.equal(await h.shared.verifyMfaMethod("actor", "password", "correct", { typ: "mfa", uid: "actor" }), false);
        await h.finish(
            {
                user_id: "actor",
                body: {
                    ticket: JSON.stringify({ typ: "mfa", uid: "actor" }),
                    mfa_type: "password",
                    data: "correct",
                },
            },
            h.response,
        );
        assert.equal(h.issued.length, 1);
        assert.equal(h.issued[0].token, undefined);
    }
});

test("non-MFA account password step-up accepts correct password and rejects wrong password", async () => {
    const h = harness();
    const ticket = { typ: "mfa", uid: "actor" };
    assert.equal(await h.shared.verifyMfaMethod("actor", "password", "wrong", ticket), false);
    assert.equal(await h.shared.verifyMfaMethod("actor", "password", "correct", ticket), true);
    await h.finish(
        {
            user_id: "actor",
            body: { ticket: JSON.stringify(ticket), mfa_type: "password", data: "correct" },
        },
        h.response,
    );
    assert.ok(h.issued[0].token);
});

test("method verification rejects foreign subjects and unrelated ticket types", async () => {
    const h = harness();
    for (const ticket of [{ typ: "mfa", uid: "other" }, { typ: "mfa_verified", uid: "actor" }, { typ: "login" }]) {
        assert.equal(await h.shared.verifyMfaMethod("actor", "password", "correct", ticket), false);
    }
});

test("TOTP, recovery code and SMS remain accepted for valid login challenges", async () => {
    const h = harness({ mfa: true });
    const ticket = { typ: "login", uid: "actor" };
    assert.equal(await h.shared.verifyMfaMethod("actor", "totp", "123456", ticket), true);
    assert.equal(await h.shared.verifyMfaMethod("actor", "totp", "invalid", ticket), false);
    assert.equal(await h.shared.verifyMfaMethod("actor", "backup", "abcd-ef12", ticket), true);
    assert.equal(await h.shared.verifyMfaMethod("actor", "backup", "abcd-ef12", ticket), false);
    assert.equal(await h.shared.verifyMfaMethod("actor", "sms", "sms-code", ticket), true);
    await h.login(
        {
            params: { authenticator_type: "totp" },
            body: { ticket: JSON.stringify(ticket), code: "123456" },
        },
        h.response,
    );
    assert.equal(h.issued[1].token, "login-token");
});

test("signed WebAuthn assertions remain accepted with the bound login challenge", async () => {
    const h = harness({ keys: 1 });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const origin = "https://instance.example";
    const challenge = "fixture-challenge";
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
    const authData = Buffer.alloc(37);
    crypto.createHash("sha256").update("instance.example").digest().copy(authData);
    authData[32] = 1;
    authData.writeUInt32BE(1, 33);
    let saved = false;
    h.setCredential({
        public_key: publicKey.export({ format: "pem", type: "spki" }),
        counter: 0,
        save: async () => {
            saved = true;
        },
    });
    const signature = crypto.sign(null, Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]), privateKey);
    const credential = {
        rawId: "ZmFrZQ",
        response: {
            clientDataJSON: clientData.toString("base64url"),
            authenticatorData: authData.toString("base64url"),
            signature: signature.toString("base64url"),
        },
    };
    assert.equal(
        await h.shared.verifyMfaMethod("actor", "webauthn", credential, {
            typ: "login",
            uid: "actor",
            ch: challenge,
            origin,
        }),
        true,
    );
    assert.equal(saved, true);
    assert.equal(
        await h.shared.verifyMfaMethod("actor", "webauthn", credential, {
            typ: "login",
            uid: "actor",
            ch: "different",
            origin,
        }),
        false,
    );
});

test("one recovery code has exactly one winner under concurrent consumption", async () => {
    const h = harness({ mfa: true });
    const results = await Promise.all(Array.from({ length: 10 }, () => h.shared.consumeBackupCode("actor", "abcd-ef12")));
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await h.shared.consumeBackupCode("actor", "abcdef12"), false);
});

test("disabled second factors reject stale login challenges", async () => {
    const h = harness();
    const ticket = { typ: "login", uid: "actor" };
    for (const [method, code] of [
        ["totp", "123456"],
        ["backup", "abcdef12"],
        ["sms", "sms-code"],
    ]) {
        assert.equal(await h.shared.verifyMfaMethod("actor", method, code, ticket), false);
    }
    const securityKeyAccount = harness({ keys: 1 });
    assert.equal(await securityKeyAccount.shared.verifyMfaMethod("actor", "backup", "abcdef12", ticket), true);
});

test("authenticated TOTP disable retains a correctly bound internal verification", async () => {
    const h = harness({ mfa: true });
    await h.disable({ user_id: "actor", headers: {}, body: { code: "123456" } }, h.response);
    assert.equal(h.issued[0].token, "existing-token");
});
