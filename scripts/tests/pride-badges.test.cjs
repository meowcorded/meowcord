const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (file, imports = {}) => {
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require: (name) => {
            if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
            if (!(name in imports)) throw Error(name);
            return imports[name];
        },
    });
    return module.exports;
};
const catalog = load("src/api/util/utility/prideBadges.ts");
const manifest = JSON.parse(fs.readFileSync("assets/badge-icons/twemoji-flags/manifest.json", "utf8"));
const harness = () => {
    const handlers = {};
    const writes = [];
    const broadcasts = [];
    const user = {
        id: "self",
        pride_badges: ["rainbow"],
        badge_ids: ["operator"],
        email: "private@example.invalid",
        rights: "secret",
    };
    load("src/api/routes/users/@me/pride-badges.ts", {
        express: {
            Router: () => ({
                get: (_path, _options, fn) => (handlers.get = fn),
                patch: (_path, _options, fn) => (handlers.patch = fn),
            }),
        },
        "@spacebar/api/middlewares": { route: (options) => options },
        "@spacebar/api/util/utility/prideBadges": catalog,
        "@spacebar/database": {
            User: {
                findOneOrFail: async ({ where, select }) => {
                    assert.equal(where.id, "self");
                    assert.deepEqual(Object.keys(select), ["id", "pride_badges"]);
                    return user;
                },
                createQueryBuilder: () => {
                    let data;
                    let id;
                    const query = {
                        update: () => query,
                        set: (value) => {
                            data = value;
                            return query;
                        },
                        where: (condition, parameters) => {
                            assert.equal(condition, "id = :user_id");
                            id = parameters.user_id;
                            return query;
                        },
                        andWhere: (condition, parameters) => {
                            assert.equal(condition, "pride_badges IS DISTINCT FROM :selected::text[]");
                            assert.equal(parameters.selected, data.pride_badges);
                            return query;
                        },
                        execute: async () => {
                            if (JSON.stringify(user.pride_badges) === JSON.stringify(data.pride_badges)) return { affected: 0 };
                            writes.push({ where: { id }, data });
                            Object.assign(user, data);
                            return { affected: 1 };
                        },
                    };
                    return query;
                },
            },
        },
        "@spacebar/schemas": {},
        "@spacebar/util": {
            FieldErrors: () => Error("invalid flags"),
            broadcastUserUpdate: async (id, flags) => broadcasts.push({ id, flags }),
        },
    });
    const invoke = async (method, body) => {
        let result;
        await handlers[method]({ user_id: "self", body }, { json: (value) => (result = value) });
        return result;
    };
    return { invoke, writes, broadcasts, user };
};

test("catalog has every upstream flag plus preserved supplemental flags and unique locally hosted flag icons and valid badge identifiers", () => {
    const count = manifest.flags.length + manifest.supplementalSlugs.length;
    assert.equal(catalog.PRIDE_BADGES.length, count);
    for (const field of ["slug", "id", "icon", "description"]) assert.equal(new Set(catalog.PRIDE_BADGES.map((b) => b[field])).size, count);
    const bySource = (source) =>
        Array.from(
            catalog.PRIDE_BADGES.filter((b) => b.source === source),
            (b) => `${b.slug} ${b.icon}`,
        );
    assert.deepEqual(bySource("twemoji-flags").sort(), manifest.flags.map((flag) => `${flag.slug} ${flag.icon}`).sort());
    assert.deepEqual(bySource("supplemental").sort(), manifest.supplementalFlags.map((flag) => `${flag.slug} ${flag.icon}`).sort());
    for (const badge of catalog.PRIDE_BADGES) {
        assert.match(badge.id, /^[0-9]+$/);
        assert.ok(BigInt(badge.id) <= 9223372036854775807n);
        const svg = fs.readFileSync(`assets/badge-icons/${badge.icon}.svg`, "utf8");
        assert.match(svg, /viewBox="0 0 36 36"/);
        assert.doesNotMatch(svg, /<(?:script|image|foreignObject)\b|(?:xlink:)?href\s*=\s*["'](?:https?:|\/\/)/i);
    }
});

test("profile projection preserves selection order, removes duplicates and ignores unknown stored flags", () => {
    const badges = catalog.prideBadges(["transgender", "rainbow", "transgender", "operator"]);
    assert.deepEqual(
        JSON.parse(JSON.stringify(badges)),
        JSON.parse(
            JSON.stringify(
                catalog.PRIDE_BADGES.filter((b) => ["transgender", "rainbow"].includes(b.slug))
                    .reverse()
                    .map(({ id, description, icon }) => ({ id, description, icon })),
            ),
        ),
    );
    assert.equal(catalog.prideBadges(null).length, 0);
});

test("own selection persists only pride flags and emits only explicit public selections", async () => {
    const h = harness();
    const result = await h.invoke("patch", {
        flags: ["transgender", "rainbow", "transgender"],
        badge_ids: ["admin"],
        user_id: "other",
    });
    assert.deepEqual(JSON.parse(JSON.stringify(h.writes)), [{ where: { id: "self" }, data: { pride_badges: ["transgender", "rainbow"] } }]);
    assert.deepEqual(Array.from(h.user.badge_ids), ["operator"]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.broadcasts)), [{ id: "self", flags: ["transgender", "rainbow"] }]);
    assert.doesNotMatch(JSON.stringify(result), /private@example|secret|operator/);
});

test("clearing selections preserves admin badges and GET returns the persisted empty selection", async () => {
    const h = harness();
    await h.invoke("patch", { flags: [] });
    const result = await h.invoke("get");
    assert.equal(result.flags.length, 0);
    assert.deepEqual(Array.from(h.user.badge_ids), ["operator"]);
});

test("unknown flags, admin IDs, invalid shapes and oversized arrays never write or broadcast", async () => {
    for (const flags of [["operator"], [catalog.PRIDE_BADGES[0].id], [null], [1], "rainbow", null, Array(catalog.PRIDE_BADGES.length + 1).fill("rainbow")]) {
        const h = harness();
        await assert.rejects(h.invoke("patch", { flags }), /invalid flags/);
        assert.equal(h.writes.length, 0);
        assert.equal(h.broadcasts.length, 0);
    }
});

test("observer events use the public user projection plus explicit pride slugs", async () => {
    const events = [];
    const presence = load("src/util/util/Presence.ts", {
        "@spacebar/database": {
            User: { getPublicUser: async () => ({ id: "self", username: "public" }) },
            Member: {
                find: async () => [
                    {
                        guild_id: "guild",
                        roles: [{ id: "guild" }, { id: "role" }],
                        toPublicMember: () => ({ id: "self", nick: "public nick" }),
                    },
                ],
            },
            Relationship: { find: async () => [] },
            Recipient: { find: async () => [] },
            Session: { find: async () => [] },
        },
        "@spacebar/util": { emitEvent: async (event) => events.push(event) },
        "@spacebar/schemas": { RelationshipType: { FRIEND: 1 } },
        typeorm: { In: (value) => value, Not: (value) => value },
    });
    await presence.broadcastUserUpdate("self", ["transgender"]);
    assert.equal(events.length, 3);
    for (const event of events) {
        assert.deepEqual(JSON.parse(JSON.stringify(event.data.user)), {
            id: "self",
            username: "public",
            pride_badges: ["transgender"],
        });
        assert.doesNotMatch(JSON.stringify(event), /email|token|rights|password|account_preferences/);
    }
});

test("unchanged selections perform no write and no observer fanout", async () => {
    const h = harness();
    const result = await h.invoke("patch", { flags: ["rainbow", "rainbow"] });
    assert.deepEqual(Array.from(result.flags), ["rainbow"]);
    assert.equal(h.writes.length, 0);
    assert.equal(h.broadcasts.length, 0);
});

test("all catalog flags can be selected together without changing assigned badges", async () => {
    const h = harness();
    const flags = Array.from(catalog.PRIDE_BADGES, (badge) => badge.slug);
    const result = await h.invoke("patch", { flags });
    assert.deepEqual(Array.from(result.flags), flags);
    assert.equal(h.user.pride_badges.length, catalog.PRIDE_BADGES.length);
    assert.deepEqual(Array.from(h.user.badge_ids), ["operator"]);
});

test("every flag slug and badge ID stays stable and the retired ID is never reused", () => {
    const slugs = [
        "rainbow",
        "original-rainbow",
        "philadelphia",
        "progress",
        "intersex-progress",
        "transgender",
        "bisexual",
        "pansexual",
        "lesbian-five",
        "lesbian-seven",
        "gay-five",
        "gay-seven",
        "asexual",
        "aromantic",
        "aroace",
        "agender",
        "nonbinary",
        "genderqueer",
        "genderfluid",
        "demiboy",
        "demigirl",
        "demigender",
        "demisexual",
        "demiromantic",
        "gray-asexual",
        "grayromantic",
        "polysexual",
        "omnisexual",
        "intersex",
        "abrosexual",
        "unlabeled",
        "neutrois",
        "androgyne",
        "achillean",
        "androsexual",
        "aspec",
        "ceres",
        "demiflux",
        "femboy",
        "genderflux",
        "genderqueer-symbol",
        "gynesexual",
        null,
        "polyamory-alternative",
        "polyamory",
        "queer",
        "sapphic",
        "straight-ally",
        "transfeminine",
        "transmasculine",
        "abroromantic",
        "aceflux",
        "ambiamorous",
        "androromantic",
        "aporagender",
        "aroflux",
        "bigender",
        "biromantic",
        "ceteroromantic",
        "ceterosexual",
        "demifluid",
        "diamoric",
        "egogender",
        "frayromantic",
        "gender-neutral",
        "gender-questioning",
        "graygender",
        "gyneromantic",
        "hijra",
        "intergender",
        "maverique",
        "mogai",
        "multigender",
        "multisexual",
        "neurogender",
        "omniromantic",
        "pangender",
        "panromantic",
        "polygender",
        "polyromantic",
        "pomosexual",
        "transneutral",
        "trigender",
        "two-spirit",
        "waria",
        "xenogender",
    ];
    assert.equal(slugs.filter(Boolean).length, catalog.PRIDE_BADGES.length);
    slugs.forEach((slug, index) => {
        const id = String(8000000000000000001n + BigInt(index));
        const badge = catalog.PRIDE_BADGES.find((item) => item.id === id);
        if (slug === null) assert.equal(badge, undefined);
        else assert.equal(badge?.slug, slug);
    });
});

test("the catalog never offers heterosexual or cisgender flags", () => {
    for (const badge of catalog.PRIDE_BADGES) assert.doesNotMatch(`${badge.slug} ${badge.description} ${badge.icon}`, /hetero|cisgender|\bcis\b|^straight(?!-ally)/i);
});

test("stored unknown selections remain visible to their owner and are never silently discarded", async () => {
    const h = harness();
    h.user.pride_badges = ["rainbow", "future-custom-flag"];
    assert.deepEqual(Array.from((await h.invoke("get")).flags), ["rainbow", "future-custom-flag"]);
    await assert.rejects(h.invoke("patch", { flags: ["rainbow", "future-custom-flag", "transgender"] }), /invalid flags/);
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.user.pride_badges, ["rainbow", "future-custom-flag"]);
});
