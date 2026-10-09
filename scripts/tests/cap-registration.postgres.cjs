const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const { createHash, createHmac, randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const enabled = process.env.CAP_REGISTRATION_TEST === "1";
const options = { skip: !enabled };
let db, entities, Config, cap, captcha, core, prng, cfg, originalCaptcha, originalRegister;
const fixtureIds = new Set();
const registrationTokens = new Set();
const scope = "fosscord-registration";
const tokenKey = (token) => `cap-token:${createHash("sha256").update(token).digest("hex")}`;

before(async () => {
    if (!enabled) return;
    assert.equal(new URL(process.env.DATABASE).pathname, "/fosscord_codex_admin");
    entities = require("../../dist/database");
    db = await entities.initDatabase();
    ({ Config } = require("../../dist/util"));
    await Config.init();
    cfg = Config.get();
    originalCaptcha = { ...cfg.security.captcha };
    originalRegister = { ...cfg.register };
    cfg.register.requireCaptcha = true;
    cfg.security.captcha = { enabled: false };
    cap = require("../../dist/api/util/utility/localCap");
    captcha = require("../../dist/api/util/utility/captcha");
    core = await import("capjs-core");
    prng = await import(pathToFileURL(path.join(path.dirname(require.resolve("capjs-core")), "prng.js")).href);
});

after(async () => {
    if (!enabled) return;
    if (cfg) {
        cfg.security.captcha = originalCaptcha;
        cfg.register = originalRegister;
    }
    for (const id of fixtureIds) await entities.RateLimit.delete({ id });
    for (const token of registrationTokens) await entities.ValidRegistrationToken.delete({ token });
    if (db) await db.destroy();
});

const solvedChallenge = async (overrides = {}) => {
    const key = createHmac("sha256", Config.get().security.requestSignature).update(scope).digest("hex");
    const challenge = await core.generateChallenge(key, {
        scope,
        instrumentation: false,
        challengeCount: 2,
        challengeDifficulty: 1,
        challengeSize: 8,
        expiresMs: 60000,
        ...overrides,
    });
    const solutions = Array.from({ length: challenge.challenge.c }, (_, index) => {
        const seed = prng.fnv1aResume(prng.fnv1a(challenge.token), String(index + 1));
        const salt = prng.prngFromHash(seed, challenge.challenge.s);
        const target = prng.prngFromHash(prng.fnv1aResume(seed, "d"), challenge.challenge.d);
        for (let nonce = 0; nonce < 100000; nonce++) {
            if (
                createHash("sha256")
                    .update(salt + nonce)
                    .digest("hex")
                    .startsWith(target)
            )
                return nonce;
        }
        throw new Error("Fixture proof-of-work solver exhausted its bounded search");
    });
    fixtureIds.add(`cap-nonce:${Buffer.from(challenge.token.split(".")[2], "base64url").toString("hex")}`);
    return { token: challenge.token, solutions };
};
const redeem = async (body) => {
    const result = await cap.redeemRegistrationChallenge(body);
    if (result.success) fixtureIds.add(tokenKey(result.token));
    return result;
};

test("production challenges retain normal proof difficulty and browser instrumentation", options, async () => {
    const before = Date.now();
    const result = await cap.createRegistrationChallenge();
    assert.deepEqual(result.challenge, { c: 50, s: 32, d: 4 });
    assert.equal(typeof result.instrumentation, "string");
    assert.ok(result.instrumentation.length > 0);
    assert.ok(result.expires >= before + 299000 && result.expires <= Date.now() + 300000);
    assert.equal((await redeem({ token: result.token, solutions: [] })).success, false);
});

test("concurrent redemption atomically claims a proof once", options, async () => {
    const body = await solvedChallenge();
    const results = await Promise.all(Array.from({ length: 16 }, () => redeem(body)));
    assert.equal(results.filter((result) => result.success).length, 1);
    assert.equal(results.filter((result) => result.reason === "already_redeemed").length, 15);
    assert.equal((await redeem(body)).reason, "already_redeemed");
});

test("concurrent registration token consumption succeeds exactly once", options, async () => {
    const result = await redeem(await solvedChallenge());
    assert.equal(result.success, true);
    const consumed = await Promise.all(Array.from({ length: 16 }, () => cap.consumeRegistrationToken(result.token)));
    assert.equal(consumed.filter(Boolean).length, 1);
    assert.equal(await cap.consumeRegistrationToken(result.token), false);
});

test("expired solved tokens and expired challenges cannot authorize registration", options, async () => {
    const result = await redeem(await solvedChallenge());
    assert.equal(result.success, true);
    await entities.RateLimit.update({ id: tokenKey(result.token) }, { expires_at: new Date(Date.now() - 1000) });
    assert.equal(await cap.consumeRegistrationToken(result.token), false);
    assert.equal((await redeem(await solvedChallenge({ expiresMs: -1000 }))).reason, "expired");
});

test("malformed proofs and wrong registration scope fail without token rows", options, async () => {
    for (const body of [null, [], "proof", {}, { token: "tampered", solutions: [] }, { token: "x".repeat(17000), solutions: [] }]) {
        assert.equal((await redeem(body)).success, false);
    }
    assert.equal((await redeem(await solvedChallenge({ scope: "different-purpose" }))).reason, "scope_mismatch");
    const valid = await solvedChallenge();
    assert.equal((await redeem({ ...valid, solutions: [] })).success, false);
    assert.equal((await redeem(valid)).success, true);
});

test("required signup challenges survive disabled, absent and third-party captcha configuration", options, async () => {
    const configurations = [{ enabled: false }, {}, { enabled: true, sitekey: "fixture", secret: "fixture" }];
    for (const value of configurations) {
        cfg.security.captcha = value;
        assert.equal(captcha.registrationCapEndpoint(), "/api/v9/auth/cap/");
        const result = await captcha.checkRegistrationCaptcha(null);
        assert.equal(result.captcha_service, "cap");
        assert.deepEqual(result.captcha_key, ["captcha-required"]);
        assert.deepEqual((await captcha.checkRegistrationCaptcha("invented-proof")).captcha_key, ["invalid-input-response"]);
    }
    cfg.security.captcha = { enabled: false };
    const result = await redeem(await solvedChallenge());
    assert.equal(await captcha.checkRegistrationCaptcha(result.token), null);
    assert.deepEqual((await captcha.checkRegistrationCaptcha(result.token)).captcha_key, ["invalid-input-response"]);
});

test("registration invitation tokens never bypass the required Cap challenge", options, async () => {
    cfg.register.allowNewRegistration = false;
    cfg.register.disabled = true;
    cfg.security.captcha = { enabled: false };
    const token = `cap-regression-${randomUUID()}`;
    registrationTokens.add(token);
    await entities.ValidRegistrationToken.create({
        token,
        expires_at: new Date(Date.now() + 60000),
    }).save();
    const router = require("../../dist/api/routes/auth/register").default;
    const handler = router.stack.find((layer) => layer.route?.methods.post).route.stack.at(-1).handle;
    let status, response;
    const savedLog = console.log;
    console.log = () => {};
    try {
        await handler(
            {
                body: { consent: true },
                ip: "192.0.2.123",
                get: (name) => (name === "Referrer" ? `http://localhost/register?token=${token}` : undefined),
            },
            {
                status(value) {
                    status = value;
                    return this;
                },
                json(value) {
                    response = value;
                    return this;
                },
            },
        );
    } finally {
        console.log = savedLog;
    }
    assert.equal(status, 400);
    assert.equal(response.captcha_service, "cap");
    assert.deepEqual(response.captcha_key, ["captcha-required"]);
});

test("preflight verification preserves a solved token until atomic registration claim", options, async () => {
    cfg.security.captcha = { enabled: false };
    const result = await redeem(await solvedChallenge());
    const checks = await Promise.all(Array.from({ length: 16 }, () => captcha.checkRegistrationCaptcha(result.token, false)));
    assert(checks.every((value) => value === null));
    assert.equal(await cap.registrationTokenAvailable(result.token), true);
    const claims = await Promise.all(Array.from({ length: 16 }, () => captcha.checkRegistrationCaptcha(result.token)));
    assert.equal(claims.filter((value) => value === null).length, 1);
    assert.equal(await cap.registrationTokenAvailable(result.token), false);
});

test("correctable password and username errors do not consume the solved registration token", options, async () => {
    const savedRegister = cfg.register;
    const savedLimit = cfg.limits.absoluteRate.register;
    cfg.limits.absoluteRate.register = { ...savedLimit, enabled: false };
    cfg.register = {
        ...originalRegister,
        requireCaptcha: true,
        allowNewRegistration: true,
        disabled: false,
        allowMultipleAccounts: true,
        enableAbuseIpDb: false,
        enableIpData: false,
        requireInvite: false,
        guestsRequireInvite: false,
        email: { ...originalRegister.email, required: false },
    };
    cfg.security.captcha = { enabled: false };
    const router = require("../../dist/api/routes/auth/register").default;
    const handler = router.stack.find((layer) => layer.route?.methods.post).route.stack.at(-1).handle;
    const result = await redeem(await solvedChallenge());
    try {
        for (const [field, body] of [
            ["password", { username: "capfixture", password: "a" }],
            [
                "username",
                {
                    username: "x".repeat(cfg.limits.user.maxUsername + 1),
                    password: "fixture-long-password-9",
                },
            ],
        ]) {
            await assert.rejects(
                handler(
                    {
                        body: { ...body, consent: true, captcha_key: result.token },
                        ip: "192.0.2.124",
                        get: () => undefined,
                        t: (key) => key,
                    },
                    {
                        status() {
                            throw new Error("A valid solved proof should reach form validation");
                        },
                    },
                ),
                (error) => error.code === 50035 && !!error.errors?.[field],
            );
            assert.equal(await cap.registrationTokenAvailable(result.token), true);
        }
        assert.equal(await captcha.checkRegistrationCaptcha(result.token), null);
        assert.equal(await cap.registrationTokenAvailable(result.token), false);
    } finally {
        cfg.register = savedRegister;
        cfg.limits.absoluteRate.register = savedLimit;
    }
});

test("closed registration exposes policy errors on username without consuming a valid proof", options, async () => {
    const savedRegister = cfg.register;
    const router = require("../../dist/api/routes/auth/register").default;
    const handler = router.stack.find((layer) => layer.route?.methods.post).route.stack.at(-1).handle;
    const result = await redeem(await solvedChallenge());
    try {
        for (const [policy, code] of [
            [{ allowNewRegistration: false, disabled: false }, "REGISTRATION_DISABLED"],
            [{ allowNewRegistration: true, disabled: true }, "DISABLED"],
        ]) {
            cfg.register = { ...originalRegister, ...policy, requireCaptcha: true };
            await assert.rejects(
                handler(
                    {
                        body: {
                            username: "capclosedfixture",
                            password: "fixture-long-password-9",
                            consent: true,
                            captcha_key: result.token,
                        },
                        ip: "192.0.2.125",
                        get: () => undefined,
                        t: (key) => key,
                    },
                    {
                        status() {
                            throw new Error("A valid proof must reach the registration policy");
                        },
                    },
                ),
                (error) => error.code === 50035 && error.errors?.username?._errors?.[0]?.code === code && !error.errors?.email,
            );
            assert.equal(await cap.registrationTokenAvailable(result.token), true);
        }
    } finally {
        cfg.register = savedRegister;
    }
});
