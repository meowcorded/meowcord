const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModule } = require("./helpers/route-harness.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));

const search = loadModule("src/api/util/utility/MessageSearch.ts", {
    "@spacebar/database/Sql": {
        isSqlite: () => false,
        sqlArrayLength: () => "0",
        sqlLike: () => "",
    },
    "lambert-server/HTTPError": class HTTPError extends Error {},
    typeorm: {
        Brackets: class Brackets {},
        In: (value) => value,
    },
    "@spacebar/database": {
        Channel: {},
        Message: {},
        Recipient: {},
        ThreadMember: {},
    },
    "@spacebar/util": {
        FieldErrors: (errors) => errors,
        getPermission: async () => ({}),
        MessageFlags: { FLAGS: { EPHEMERAL: 1 } },
    },
    "@spacebar/schemas": {
        MessageType: { DEFAULT: 0, REPLY: 1, APPLICATION_COMMAND: 2, CONTEXT_MENU_COMMAND: 3 },
    },
    "@spacebar/api/util/handlers/FieldCaps": {
        messageSearchErrors: () => ({}),
        searchTabErrors: () => ({}),
    },
});

test("bracketed search arrays become canonical query fields", () => {
    const query = {
        content: "holiday",
        "has[0]": "image",
        "has[1]": "-file",
        "author_id[0]": "456",
        "author_type[]": "bot",
        "mentions[2]": "789",
        "channel_id[0]": "10",
        "channel_id[1]": "11",
    };
    const normalized = search.normalizeMessageSearchQuery(query);
    assert.deepEqual(plain(normalized), {
        content: "holiday",
        has: ["image", "-file"],
        author_id: ["456"],
        author_type: ["bot"],
        mentions: ["789"],
        channel_id: ["10", "11"],
    });
});

test("plain and bracketed values are merged in order", () => {
    const normalized = search.normalizeMessageSearchQuery({
        has: "link",
        "has[0]": "image",
        "has[1]": "-file",
        author_id: ["1", "2"],
        "author_id[0]": "3",
    });
    assert.deepEqual(plain(normalized.has), ["link", "image", "-file"]);
    assert.deepEqual(plain(normalized.author_id), ["1", "2", "3"]);
});

test("empty and unrelated bracket keys are not treated as arrays", () => {
    const normalized = search.normalizeMessageSearchQuery({
        "has[0]": "",
        "has[foo]": "image",
        "author_id[0][1]": "456",
    });
    assert.deepEqual(plain(normalized.has), []);
    assert.equal(normalized["has[foo]"], "image");
    assert.equal(normalized["author_id[0][1]"], "456");
});

test("normalization is idempotent and leaves the input unchanged", () => {
    const query = { "has[0]": "image", "author_id[0]": "456" };
    const once = search.normalizeMessageSearchQuery(query);
    const twice = search.normalizeMessageSearchQuery(once);
    assert.deepEqual(plain(once), { has: ["image"], author_id: ["456"] });
    assert.deepEqual(plain(twice), plain(once));
    assert.deepEqual(query, { "has[0]": "image", "author_id[0]": "456" });
});
