const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const load = (file, imports = {}, globals = {}) => {
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.React,
        },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require: (name) => {
            if (!(name in imports)) throw Error(name);
            return imports[name];
        },
        ...globals,
    });
    return module.exports;
};
const utilities = () =>
    load("src/api/util/utility/profile.ts", {
        "@spacebar/database": {},
        "@spacebar/util": {},
        "@spacebar/schemas": {},
    });

test("subscription badges are removed without hiding ordinary admin or pride badges", () => {
    const { isSubscriptionBadge } = utilities();
    for (const id of ["premium", "premium_tenure_12_month_v2", "nitro", "subscriber", "guild_booster"]) assert.equal(isSubscriptionBadge({ id, icon: "generic" }), true);
    assert.equal(isSubscriptionBadge({ id: "numeric", icon: "2ba85e8026a8614b640c2837bcdfe21b" }), true);
    assert.equal(isSubscriptionBadge({ id: "numeric", icon: "premium_tenure_72_month_v2" }), true);
    for (const id of ["operator", "8000000000000000001", "premium-art-contest"]) assert.equal(isSubscriptionBadge({ id, icon: "pride_rainbow" }), false);
});

test("profile response keeps free feature entitlements and custom badges without subscription tenure", async () => {
    const handlers = {};
    const user = {
        id: "self",
        premium_type: 2,
        created_at: new Date("2020-01-01"),
        badge_ids: ["operator", "premium"],
        pride_badges: ["rainbow"],
        connected_accounts: [],
        toPartialUser: () => ({ id: "self", premium_type: 2 }),
    };
    const query = {
        leftJoin: () => query,
        addSelect: () => query,
        leftJoinAndSelect: () => query,
        where: () => query,
        getOneOrFail: async () => user,
    };
    load("src/api/routes/users/#user_id/profile.ts", {
        express: {
            Router: () => ({ get: (_path, _options, fn) => (handlers.get = fn), patch: () => {} }),
        },
        typeorm: { In: (x) => x },
        "@spacebar/api/middlewares": { route: (x) => x },
        "@spacebar/api/util/utility/milestones": { milestones: {}, earnedMilestoneBadges: () => [] },
        "@spacebar/api/util": { profileMetadata: () => ({ theme_colors: [123, 456] }), STAFF_BADGE_ID: "1", ensureStaffBadge: async () => ({ icon: "staff" }) },
        "@spacebar/database": {
            User: { createQueryBuilder: () => query },
            Member: { find: async () => [] },
            Badge: {
                find: async () => [
                    { id: "operator", icon: "operator" },
                    { id: "premium", icon: "subscriber" },
                ],
            },
            Relationship: {},
        },
        "@spacebar/util": { loadStaffRoles: async () => ({ roles: new Map(), members: new Map() }), staffBadgeRole: () => null, instanceName: () => "Meowcord" },
        "@spacebar/schemas": {},
        "@spacebar/api/util/utility/prideBadges": {
            prideBadges: () => [{ id: "8000000000000000001", icon: "pride_rainbow" }],
        },
        "@spacebar/api/util/utility/profile": utilities(),
        "@spacebar/api/util/utility/badgeSettings": load("src/api/util/utility/badgeSettings.ts", {
            "@spacebar/util": {},
            "./staffBadge": { STAFF_BADGE_ID: "1" },
            "./prideBadges": { PRIDE_BADGES: [] },
        }),
        "@spacebar/api/util/handlers/Application": {},
    });
    let result;
    await handlers.get({ user_id: "self", params: { user_id: "@me" }, query: {} }, { json: (x) => (result = x) });
    assert.equal(result.premium_type, 2);
    assert.equal(result.user.premium_type, 2);
    assert.equal(result.premium_since, null);
    assert.equal(result.premium_guild_since, null);
    assert.deepEqual(
        Array.from(result.badges, (x) => x.id),
        ["operator", "8000000000000000001"],
    );
    assert.deepEqual(Array.from(result.user_profile.theme_colors), [123, 456]);
});

test("branding removes subscription labels in nested translation text while keeping ICU arguments and technical keys", () => {
    const { brandMessages } = load(
        "client/plugins/fosscordBranding/messages.ts",
        {},
        {
            window: { GLOBAL_ENV: { INSTANCE_NAME: "Test Instance" } },
            location: { host: "fosscord.localhost", origin: "http://fosscord.localhost" },
        },
    );
    const messages = {
        PREMIUM_TIER_2: ["Nitro and Premium customization", [8, "$b", ["NITRO CLASSIC"]], [6, "premiumTier", { one: ["Nitro Basic"], other: ["Premium features"] }]],
        neutral: ["ordinary text"],
        crisis: ["Text DISCORD to 741741"],
    };
    const result = brandMessages(messages);
    assert.doesNotMatch(JSON.stringify(result.PREMIUM_TIER_2), /nitro|premium(?!Tier)/i);
    assert.equal(result.PREMIUM_TIER_2[1][1], "$b");
    assert.equal(result.PREMIUM_TIER_2[2][1], "premiumTier");
    assert.deepEqual(Array.from(result.crisis), ["Text DISCORD to 741741"]);
    assert.deepEqual(Array.from(result.neutral), ["ordinary text"]);
});

test("native gradient toggle disables pending colors and restores the selected pair through native save state", () => {
    let remembered;
    const React = {
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useRef: (initial) => (remembered ??= { current: initial }),
    };
    const gradient = load("client/plugins/fosscordNoNitroUpsells/gradient.tsx", {
        "@webpack/common": { React, Checkbox: "Checkbox", Text: "Text" },
    });
    assert.equal(gradient.renderGradientToggle({ user: { id: "self" }, guildId: "guild" }, [123, 456], [111, 222]), null);
    let selected;
    const props = { user: { id: "self" }, onThemeColorsChange: (colors) => (selected = colors) };
    const render = (pending, current = [123, 456]) => {
        const element = gradient.renderGradientToggle({ ...props, pendingColors: pending }, current, [111, 222]);
        return element.type(element.props).props.children[0];
    };
    let checkbox = render(undefined);
    assert.equal(checkbox.props.value, true);
    checkbox.props.onChange(null, false);
    assert.equal(selected, null);
    checkbox = render(null);
    assert.equal(checkbox.props.value, false);
    checkbox.props.onChange(null, true);
    assert.deepEqual(Array.from(selected), [123, 456]);
    checkbox = render([789, 1011]);
    checkbox.props.onChange(null, false);
    checkbox = render(null);
    checkbox.props.onChange(null, true);
    assert.deepEqual(Array.from(selected), [789, 1011]);
});
