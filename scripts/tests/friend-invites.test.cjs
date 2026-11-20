const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const FRIEND = 1;
const BLOCKED = 2;
const errors = {
    UNKNOWN_INVITE: new Error("Unknown invite"),
    CANNOT_FRIEND_SELF: new Error("Cannot friend self"),
    FRIEND_REQUEST_BLOCKED: new Error("Blocked"),
    MAXIMUM_FRIENDS: { withParams: () => new Error("Maximum friends") },
};

const load = (rows, invites, events) => {
    const module = { exports: {} };
    const key = (where) => `${where.from_id}>${where.to_id}`;
    class Relationship {
        static create(values) {
            return Object.assign(new Relationship(), values);
        }
        static async findOne({ where }) {
            return rows.get(key(where)) ?? null;
        }
        static async count({ where }) {
            return [...rows.values()].filter((row) => row.from_id === where.from_id).length;
        }
        async save() {
            rows.set(key(this), this);
            return this;
        }
        toPublicRelationship() {
            return { id: this.to_id, type: this.type };
        }
    }
    vm.runInNewContext(fs.readFileSync("dist/api/util/utility/friendInvites.js", "utf8"), {
        module,
        exports: module.exports,
        require: (name) =>
            ({
                tslib: { __importDefault: (m) => ({ default: m }) },
                "node:crypto": require("node:crypto"),
                typeorm: { In: (v) => v, IsNull: () => null, LessThan: (v) => v, MoreThan: (v) => v },
                "@spacebar/schemas": { RelationshipType: { FRIEND, BLOCKED } },
                "@spacebar/util": {
                    Config: { get: () => ({ limits: { user: { maxFriends: 2 } } }) },
                    DiscordApiErrors: errors,
                    Snowflake: { generate: () => String(Math.random()).slice(2) },
                    emitEvent: async (event) => events.push(event),
                    getUserPresence: async () => ({ status: "online" }),
                },
                "@spacebar/database": {
                    Relationship,
                    User: { findOneOrFail: async ({ where }) => ({ id: where.id, toPublicUser: () => ({ id: where.id }) }) },
                    Invite: {
                        delete: async ({ code }) => invites.delete(code),
                        update: async ({ code }, values) => Object.assign(invites.get(code), values),
                        createQueryBuilder: () => {
                            let code;
                            const query = {
                                update: () => query,
                                set: () => query,
                                where: (_sql, params) => {
                                    code = params.code;
                                    return query;
                                },
                                execute: async () => {
                                    const row = invites.get(code);
                                    return { affected: row && (row.max_uses === 0 || row.uses < row.max_uses) ? 1 : 0 };
                                },
                            };
                            return query;
                        },
                    },
                },
            })[name],
    });
    return module.exports;
};

const invite = (overrides = {}) => ({ code: "abc", inviter_id: "1", uses: 0, max_uses: 5, isExpired: () => false, ...overrides });

test("accepting a friend invite makes both users friends and counts the use", async () => {
    const rows = new Map();
    const found = invite();
    const invites = new Map([["abc", found]]);
    const events = [];
    const { acceptFriendInvite } = load(rows, invites, events);
    const result = await acceptFriendInvite(found, "2");
    assert.equal(result.new_friend, true);
    assert.equal(rows.get("2>1").type, FRIEND);
    assert.equal(rows.get("1>2").type, FRIEND);
    assert.equal(found.uses, 1);
    assert.deepEqual(
        events.map((e) => `${e.event}:${e.user_id}`),
        ["RELATIONSHIP_ADD:2", "RELATIONSHIP_ADD:1", "PRESENCE_UPDATE:2", "PRESENCE_UPDATE:1"],
    );
    assert.equal((await acceptFriendInvite(found, "2")).new_friend, false);
});

test("a friend invite turns pending requests into a friendship and is deleted at its last use", async () => {
    const rows = new Map();
    const found = invite({ uses: 4 });
    const invites = new Map([["abc", found]]);
    const { acceptFriendInvite } = load(rows, invites, []);
    rows.set("1>2", Object.assign(Object.create(null), { from_id: "1", to_id: "2", type: 4, nickname: "pal", save() {}, toPublicRelationship: () => ({}) }));
    await acceptFriendInvite(found, "2");
    assert.equal(rows.get("1>2").type, FRIEND);
    assert.equal(rows.get("1>2").nickname, "pal");
    assert.equal(invites.has("abc"), false);
});

test("a friend invite refuses self, blocks, expired invites and full friend lists", async () => {
    const { acceptFriendInvite } = load(new Map(), new Map(), []);
    await assert.rejects(acceptFriendInvite(invite(), "1"), errors.CANNOT_FRIEND_SELF);
    await assert.rejects(acceptFriendInvite(invite({ isExpired: () => true }), "2"), errors.UNKNOWN_INVITE);

    const blocked = new Map([["1>2", { from_id: "1", to_id: "2", type: BLOCKED }]]);
    await assert.rejects(load(blocked, new Map(), []).acceptFriendInvite(invite(), "2"), errors.FRIEND_REQUEST_BLOCKED);

    const full = new Map([
        ["2>8", { from_id: "2", to_id: "8", type: FRIEND }],
        ["2>9", { from_id: "2", to_id: "9", type: FRIEND }],
    ]);
    await assert.rejects(load(full, new Map(), []).acceptFriendInvite(invite(), "2"), /Maximum friends/);
});

test("friend invites are served without a guild or channel", () => {
    const entity = fs.readFileSync("src/database/entities/Invite.ts", "utf8");
    assert.match(entity, /return !this\.guild_id && !this\.channel_id && !!this\.inviter_id;/);
    assert.match(entity, /type: InviteType\.FRIEND,\s+channel: null,/);
    const routes = fs.readFileSync("src/api/routes/invites/index.ts", "utf8");
    assert.match(routes, /if \(invite\.inviter_id !== req\.user_id\) throw DiscordApiErrors\.UNKNOWN_INVITE;/);
});
