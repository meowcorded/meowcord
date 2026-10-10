const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");
function harness(database) {
    let handler, guard;
    class HTTPError extends Error {
        constructor(message, status) {
            super(message);
            this.status = status;
        }
    }
    const imports = {
        express: {
            Router: () => ({
                get: (path, options, run) => {
                    guard = options;
                    handler = run;
                },
            }),
        },
        "@spacebar/api/middlewares": { route: (options) => options },
        "@spacebar/database": { getDatabase: () => database },
        "@spacebar/api/util": { getSystemAccount: async () => ({ id: "1" }) },
        "@spacebar/schemas": { ChannelType: { DM: 1 } },
        "lambert-server/HTTPError": { HTTPError },
    };
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/routes/admin/conversations/index.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        { module, exports: module.exports, require: (name) => (name === "@spacebar/database/Sql" ? require("../../dist/database/Sql.js") : imports[name]) },
    );
    const response = {
        set() {
            return this;
        },
        json(body) {
            this.body = body;
        },
    };
    return { handler, guard, response };
}
test("Official user directory is operator-only and bounds literal search/pagination", async () => {
    let parameters;
    const h = harness({
        query: async (sql, args) => {
            parameters = args;
            return [];
        },
    });
    assert.equal(h.guard.right, "OPERATOR");
    assert.equal(h.guard.spacebarOnly, true);
    await h.handler({ query: { q: "50%_", offset: "50" } }, h.response);
    assert.equal(parameters[3], "%50\\%\\_%");
    assert.equal(parameters[4], 50);
    for (const query of [{ q: ["name"] }, { q: "x".repeat(101) }, { offset: "-1" }, { offset: "10000000" }])
        await assert.rejects(h.handler({ query }, h.response), (error) => error.status === 400);
});
test("PostgreSQL directory puts real incoming support DMs first, excludes groups and searches/pages every ordinary user", {
    skip: process.env.OFFICIAL_DIRECTORY_POSTGRES !== "1" ? "Requires guarded isolated PostgreSQL directory test" : false,
}, async () => {
    const env = Object.fromEntries(
        fs
            .readFileSync(process.env.OFFICIAL_DIRECTORY_DEMO_ENV || "/tmp/fosscord-admin-perf/.env", "utf8")
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.equal(new URL(env.DATABASE).pathname, "/fosscord_codex_admin");
    const { Client } = require("pg");
    const client = new Client({ connectionString: env.DATABASE });
    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query(`CREATE TEMP TABLE users(id bigint PRIMARY KEY, username text,global_name text,discriminator text DEFAULT '0',avatar text,deleted boolean DEFAULT false,bot boolean DEFAULT false,system boolean DEFAULT false) ON COMMIT DROP;
 CREATE TEMP TABLE channels(id bigint PRIMARY KEY,type integer,guild_id bigint) ON COMMIT DROP;
 CREATE TEMP TABLE recipients(channel_id bigint,user_id bigint) ON COMMIT DROP;
 CREATE TEMP TABLE messages(channel_id bigint,author_id bigint,timestamp timestamptz) ON COMMIT DROP;
 INSERT INTO users(id,username,system) VALUES(1,'official',false);
 INSERT INTO users(id,username) VALUES(2,'Alice'),(3,'Zed'),(4,'Amy'),(5,'Aaron'),(9,'GroupUser'),(10,'Weird%Name');
 INSERT INTO users(id,username,deleted,bot,system) VALUES(6,'Deleted',true,false,false),(7,'Bot',false,true,false),(8,'System',false,false,true);
 INSERT INTO channels(id,type) VALUES(11,1),(12,1),(13,1),(14,1);
 INSERT INTO recipients VALUES(11,1),(11,3),(12,1),(12,4),(13,1),(13,2),(14,1),(14,5),(14,9);
 INSERT INTO messages VALUES(11,3,'2026-01-04'),(12,4,'2026-01-02'),(13,1,'2026-01-06'),(14,9,'2026-01-08');`);
        const h = harness({ query: async (sql, args) => (await client.query(sql, args)).rows });
        await h.handler({ query: {} }, h.response);
        assert.deepEqual(
            Array.from(h.response.body.users, (user) => user.id),
            ["3", "4", "2", "5", "9", "10"],
        );
        assert.deepEqual(
            Array.from(h.response.body.users, (user) => user.has_replied),
            [true, true, false, false, false, false],
        );
        assert.equal(h.response.body.users.find((user) => user.id === "9").channel_id, null);
        await h.handler({ query: { q: "%" } }, h.response);
        assert.deepEqual(
            Array.from(h.response.body.users, (user) => user.id),
            ["10"],
        );
        await h.handler({ query: { q: "3" } }, h.response);
        assert.deepEqual(
            Array.from(h.response.body.users, (user) => user.id),
            ["3"],
        );
        await client.query("INSERT INTO users(id,username) SELECT n,'Extra'||n FROM generate_series(100,160) n");
        await h.handler({ query: {} }, h.response);
        const first = h.response.body;
        assert.equal(first.users.length, 50);
        assert.equal(first.has_more, true);
        await h.handler({ query: { offset: String(first.offset) } }, h.response);
        assert.equal(h.response.body.users.length, 17);
        assert.equal(h.response.body.has_more, false);
        assert.equal(new Set([...first.users, ...h.response.body.users].map((user) => user.id)).size, 67);
    } finally {
        await client.query("ROLLBACK");
        await client.end();
    }
});
