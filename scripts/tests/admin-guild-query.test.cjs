const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function harness() {
    let handler;
    const calls = [],
        query = {};
    for (const name of ["select", "addSelect", "orderBy", "limit", "offset", "where"])
        query[name] = (...args) => {
            calls.push([name, ...args]);
            return query;
        };
    query.getRawAndEntities = async () => {
        calls.push(["execute"]);
        return { entities: [], raw: [] };
    };
    query.getCount = async () => 0;
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync("src/api/routes/admin/guilds/index.ts", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require(name) {
            if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
            if (name === "express")
                return {
                    Router: () => ({
                        get: (_path, options, fn) => {
                            assert.equal(options.right, "MANAGE_GUILDS");
                            handler = fn;
                        },
                    }),
                };
            if (name === "typeorm") return { In: (ids) => ids };
            if (name === "@spacebar/api/middlewares") return { route: (options) => options };
            if (name === "@spacebar/database") return { Guild: { createQueryBuilder: () => query }, Member: {}, User: {} };
            if (name === "lambert-server/HTTPError")
                return {
                    HTTPError: class extends Error {
                        constructor(message, status) {
                            super(message);
                            this.status = status;
                        }
                    },
                };
            throw Error(name);
        },
    });
    return { calls, run: (parameters) => handler({ query: parameters }, { json: () => {} }) };
}
test("server search rejects malformed inputs before accessing the database", async () => {
    for (const parameters of [
        { limit: ["1", "2"] },
        { limit: "Infinity" },
        { limit: "1.5" },
        { limit: "" },
        { offset: "-1" },
        { offset: "NaN" },
        { offset: "9007199254740992" },
        { q: ["a", "b"] },
        { q: "a".repeat(257) },
        { q: "99999999999999999999" },
    ]) {
        const h = harness();
        await assert.rejects(h.run(parameters), (error) => error.status === 400);
        assert.equal(h.calls.length, 0);
    }
});
test("server pagination applies defaults and bounded limits", async () => {
    for (const [parameters, limit, offset] of [
        [{}, 50, 0],
        [{ limit: "200", offset: "25" }, 100, 25],
        [{ limit: "0" }, 1, 0],
    ]) {
        const h = harness();
        await h.run(parameters);
        assert.deepEqual(
            h.calls.find(([name]) => name === "limit"),
            ["limit", limit],
        );
        assert.deepEqual(
            h.calls.find(([name]) => name === "offset"),
            ["offset", offset],
        );
        assert.deepEqual(
            h.calls.find(([name]) => name === "orderBy"),
            ["orderBy", "guild.id", "DESC"],
        );
    }
});
test("server search escapes wildcard characters and preserves exact ids", async () => {
    const h = harness();
    await h.run({ q: " A_%\\B " });
    const clause = h.calls.find(([name]) => name === "where");
    assert.equal(clause[1], "guild.name ILIKE :q");
    assert.equal(clause[2].q, "%A\\_\\%\\\\B%");
    const id = harness();
    await id.run({ q: "123456789012345678" });
    const exact = id.calls.find(([name]) => name === "where");
    assert.equal(exact[1], "guild.id = :id");
    assert.equal(exact[2].id, "123456789012345678");
});
