const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const RAINBOW = "8000000000000000001";
const TRANSGENDER = "8000000000000000006";
const NONBINARY = "8000000000000000017";
const BUG_HUNTER = "42";

const settingsModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/api/util/utility/badgeSettings.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
        exports: settingsModule.exports,
        module: settingsModule,
        require(name) {
            if (name === "@spacebar/util") return { FieldErrors: (fields) => Object.assign(Error("invalid"), { fields }) };
            if (name === "./staffBadge") return { STAFF_BADGE_ID: "1" };
            if (name === "./prideBadges") return { PRIDE_BADGES: [RAINBOW, TRANSGENDER, NONBINARY].map((id) => ({ id })) };
            throw Error(name);
        },
    },
);
const { arrangeBadges, badgeSettings, mergeBadgeSettings, MAX_BADGE_SETTING_IDS } = settingsModule.exports;

const badges = [{ id: "1" }, { id: "staff-role-55" }, { id: RAINBOW }, { id: TRANSGENDER }, { id: NONBINARY }, { id: BUG_HUNTER }];
const ids = (list) => Array.from(list, (badge) => badge.id);

test("badges keep their original order without settings", () => {
    const { visible, hidden } = arrangeBadges(badges, badgeSettings({ account_preferences: {} }));
    assert.deepEqual(ids(visible), ids(badges));
    assert.equal(hidden.length, 0);
});

test("display order moves listed badges first and keeps the rest in their order", () => {
    const { visible } = arrangeBadges(badges, { display_order: [NONBINARY], hidden_badges: [] });
    assert.deepEqual(ids(visible), ["1", "staff-role-55", NONBINARY, RAINBOW, TRANSGENDER, BUG_HUNTER]);
});

test("staff badges stay first and neither staff nor pride badges can be hidden", () => {
    const { visible, hidden } = arrangeBadges(badges, { display_order: [TRANSGENDER, "1"], hidden_badges: ["1", "staff-role-55", RAINBOW, BUG_HUNTER] });
    assert.deepEqual(ids(visible), ["1", "staff-role-55", TRANSGENDER, RAINBOW, NONBINARY]);
    assert.deepEqual(ids(hidden), [BUG_HUNTER]);
});

test("saved settings keep only the user's own arrangeable badges", () => {
    const merged = mergeBadgeSettings({ display_order: [], hidden_badges: [] }, badges, {
        display_order: [TRANSGENDER, "1", "staff-role-55", "9999", RAINBOW, TRANSGENDER],
        hidden_badges: [17, NONBINARY, 42],
    });
    assert.deepEqual(JSON.parse(JSON.stringify(merged)), { display_order: [TRANSGENDER, RAINBOW], hidden_badges: [BUG_HUNTER] });
});

test("a partial update keeps the other saved list", () => {
    const current = { display_order: [TRANSGENDER], hidden_badges: [BUG_HUNTER] };
    assert.deepEqual(JSON.parse(JSON.stringify(mergeBadgeSettings(current, badges, { hidden_badges: [] }))), { display_order: [TRANSGENDER], hidden_badges: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(mergeBadgeSettings(current, badges, {}))), current);
});

test("malformed settings are rejected with a field error", () => {
    const current = { display_order: [], hidden_badges: [] };
    for (const body of [
        { display_order: "x" },
        { hidden_badges: [{}] },
        { hidden_badges: ["has space"] },
        { display_order: ["x".repeat(65)] },
        { display_order: Array.from({ length: MAX_BADGE_SETTING_IDS + 1 }, (_, index) => `${index}`) },
    ]) {
        assert.throws(
            () => mergeBadgeSettings(current, badges, body),
            (error) => Object.keys(error.fields).length === 1,
        );
    }
});

test("hiding a pride badge is a per-user setting with no instance switch", () => {
    const sources = [
        "src/api/util/utility/badgeSettings.ts",
        "src/api/util/utility/profileBadges.ts",
        "src/api/routes/users/@me/badges/settings.ts",
        "client/plugins/fosscordProfileBadges/index.ts",
    ].map((path) => fs.readFileSync(path, "utf8"));
    for (const source of sources) {
        assert.doesNotMatch(source, /Config\.get\(\)\.(?:pride|badge)|process\.env|options:\s*\{|settings\.store/i);
    }
    assert.match(sources[2], /loadBadgeOwner\(req\.user_id, req\.user_id\)/);
});

test("the client maps unknown profile badge ids to themselves and staff to the staff directory id", () => {
    const source = fs.readFileSync("client/plugins/fosscordProfileBadges/index.ts", "utf8");
    const match = source.match(/match: \/(.+)\/,\n/)[1];
    const regex = new RegExp(match.replaceAll("\\i", "[A-Za-z_$][\\w$]*"));
    const replace = source.match(/replace: "(.+)",\n/)[1];
    const original = 'function o(e){let t=l[e];if(null!=t)return t;let n=i.$[e.toUpperCase()];return"number"==typeof n?n:void 0}';
    const patched = original.replace(regex, replace.replace("$self", "self"));
    assert.notEqual(patched, original);
    const directoryBadgeId = (id) => (id === "1" || id.startsWith("staff-role-") ? 22 : ["18", "19", "20", "21"].includes(id) ? Number(id) : id);
    const lookup = new Function("l", "i", "self", `${patched};return o;`)({ premium_tenure_1_month_v2: 1 }, { $: { HYPESQUAD: 3 } }, { directoryBadgeId });
    assert.equal(lookup("premium_tenure_1_month_v2"), 1);
    assert.equal(lookup("hypesquad"), 3);
    assert.equal(lookup(RAINBOW), RAINBOW);
    assert.equal(lookup("18"), 18);
    assert.equal(lookup("19"), 19);
    assert.equal(lookup("20"), 20);
    assert.equal(lookup("21"), 21);
    assert.equal(lookup("1"), 22);
    assert.equal(lookup("staff-role-55"), 22);
});

const milestonesModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/api/util/utility/milestones.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
    }).outputText,
    {
        exports: milestonesModule.exports,
        module: milestonesModule,
        require(name) {
            if (name === "@spacebar/util") return { ASSETS_FOLDER: `${process.cwd()}/assets` };
            return require(name);
        },
    },
);

const directoryModule = { exports: {} };
vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/api/util/utility/profileBadges.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText,
    {
        exports: directoryModule.exports,
        module: directoryModule,
        require(name) {
            if (name === "node:fs" || name === "node:path") return require(name);
            if (name === "@spacebar/database") return {};
            if (name === "@spacebar/util") return { ASSETS_FOLDER: `${process.cwd()}/assets`, Config: { get: () => ({ cdn: { endpointPublic: "https://instance.example/" } }) } };
            if (name === "./badgeSettings") return settingsModule.exports;
            if (name === "./remoteBadges") return {};
            if (name === "./milestones") return milestonesModule.exports;
            throw Error(name);
        },
    },
);

test("earned activity badge menus reflect real totals, next targets and previews", () => {
    const preferences = {
        activity_progress: {
            played_ms: 1809 * 3600000,
            streamed_ms: 35 * 3600000,
            games: Array.from({ length: 90 }, (_, index) => String(index)),
            last_credit: 0,
            awards: { "20:1": "2026-11-12T10:00:00.000Z", "20:1000": "2026-11-12T11:00:00.000Z" },
        },
    };
    for (const [id, tier, remaining] of [
        ["19", "breakout", 40],
        ["20", "ironclad", 191],
        ["21", "polymath", 10],
    ]) {
        const badge = directoryModule.exports.directoryBadge({ id, description: "activity", icon: "test" }, false, { account_preferences: preferences });
        assert.equal(badge.badge_id, Number(id));
        assert.equal(badge.owned, true);
        assert.equal(badge.is_earnable, true);
        assert.equal(badge.tiers.length, 10);
        assert.equal(badge.current_tier, tier);
        assert.match(badge.progress[0].progress_helper_text, new RegExp(String(remaining)));
        assert.ok(badge.tiers.every((item) => item.milestone_text.length > 0));
        assert.doesNotMatch(JSON.stringify(badge), /test award/i);
        assert.ok(badge.info_label.length > 0);
    }
    const game = directoryModule.exports.directoryBadge({ id: "20", description: "activity", icon: "test" }, false, { account_preferences: preferences });
    assert.equal(game.info_label, "1,809 hours of games played");
    assert.equal(game.obtained_at, "2026-11-12T10:00:00.000Z");
    assert.equal(game.tier_obtained_at.ironclad, "2026-11-12T11:00:00.000Z");
});

test("accounts without recorded activity receive locked badges and zero progress", () => {
    for (const id of ["19", "20", "21"]) {
        const badge = directoryModule.exports.directoryBadge({ id, description: "activity", icon: "test" }, false);
        assert.equal(badge.owned, false);
        assert.equal(badge.current_tier, null);
        assert.equal(badge.next_tier, badge.tiers[0].key);
        assert.equal(badge.progress[0].current, 0);
        assert.equal(badge.obtained_at, null);
    }
});

test("staff badge retains its custom instance text and native directory identifier", () => {
    const badge = directoryModule.exports.directoryBadge({ id: "1", description: "Empathist staff", icon: "staff" }, false);
    assert.equal(badge.badge_id, 22);
    assert.equal(badge.name, "Empathist staff");
    assert.equal(badge.tiers.length, 0);
});

test("local milestone menus show requirements without changing data-sharing consent", () => {
    const source = fs.readFileSync("client/plugins/fosscordProfileBadges/index.ts", "utf8");
    const regex = /(\(0,[A-Za-z_$][\w$]*\.Jn\)\(([A-Za-z_$][\w$]*\.badge_id)\))/g;
    const original = "const gate=(0,N.Jn)(badge.badge_id)&&!consent;return gate;";
    const patched = original.replace(regex, "$1&&!self.isLocalMilestone($2)");
    const gate = new Function("N", "badge", "consent", "self", patched);
    const self = { isLocalMilestone: (id) => [19, 20, 21].includes(id) };
    for (const id of [19, 20, 21]) assert.equal(gate({ Jn: () => true }, { badge_id: id }, false, self), false);
    assert.equal(gate({ Jn: () => true }, { badge_id: 99 }, false, self), true);
    assert.match(source, /find: "2026-10-badge-directory-updates"/);
    assert.doesNotMatch(source, /hasConsented\s*[:=]|PERSONALIZATION/);
});

test("account age keeps actual anniversaries and the official tier names", () => {
    const { milestoneProgress } = milestonesModule.exports;
    const owner = { created_at: new Date("2020-02-29T08:00:00.000Z") };
    assert.equal(milestoneProgress("18", owner, new Date("2021-02-28T07:59:59.000Z")).current, undefined);
    const year = milestoneProgress("18", owner, new Date("2021-02-28T08:00:00.000Z"));
    assert.equal(year.current.name, "Seed");
    assert.equal(year.dates.one_year, "2021-02-28T08:00:00.000Z");
    assert.equal(milestoneProgress("18", owner, new Date("2023-02-28T08:00:00.000Z")).current.name, "Sapling");
    assert.equal(milestoneProgress("18", owner, new Date("2024-02-29T08:00:00.000Z")).current.name, "Bud");
});

test("account-age tiers ignore grants and never backdate account creation", () => {
    const { milestoneProgress } = milestonesModule.exports;
    const now = new Date("2026-11-12T10:00:00.000Z");
    const owner = { created_at: now, account_preferences: { badge_grants: { 18: { tier: "nine_years", at: now.toISOString() } } } };
    const age = milestoneProgress("18", owner, now);
    assert.equal(age.current, undefined);
    assert.equal(age.amount, 0);
    assert.equal(Object.keys(age.dates).length, 0);
    assert.equal(owner.created_at, now);
});

test("every account-year tier unlocks at its UTC anniversary", () => {
    const { milestoneProgress } = milestonesModule.exports;
    const keys = ["one_year", "two_years", "three_years", "four_years", "five_years", "six_years", "seven_years", "eight_years", "nine_years", "ten_years"];
    for (const [created, month, day] of [
        ["2016-11-12T19:34:56.789Z", 10, 12],
        ["2016-01-31T19:34:56.789Z", 0, 31],
        ["2016-02-29T19:34:56.789Z", 1, 29],
    ]) {
        const owner = { created_at: new Date(created) };
        for (let index = 0; index < keys.length; index++) {
            const year = 2017 + index;
            const anniversary = new Date(Date.UTC(year, month, day === 29 && month === 1 && year % 4 !== 0 ? 28 : day, 19, 34, 56, 789));
            const before = milestoneProgress("18", owner, new Date(anniversary.getTime() - 1));
            const after = milestoneProgress("18", owner, anniversary);
            assert.equal(before.current?.key, keys[index - 1]);
            assert.equal(after.current.key, keys[index]);
            assert.equal(after.dates[keys[index]], anniversary.toISOString());
        }
    }
});

test("the milestone catalogue contains account age and activity without Nitro", () => {
    const { milestones } = milestonesModule.exports;
    assert.deepEqual(Object.keys(milestones).sort(), ["18", "19", "20", "21"]);
    assert.doesNotMatch(JSON.stringify(milestones), /nitro|premium|opal/i);
});
