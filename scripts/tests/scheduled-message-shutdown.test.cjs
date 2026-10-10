const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { EventEmitter } = require("node:events");

test("scheduled messages cancel timers, drain the due scan and leave unclaimed messages for restart", async () => {
    const lifecycle = { eventEmitter: new EventEmitter() };
    const timers = [];
    const cleared = [];
    let finish;
    let scans = 0;
    let dispatches = 0;
    const query = {};
    for (const name of ["select", "where", "andWhere", "orderBy", "addOrderBy", "take"]) query[name] = () => query;
    query.getMany = () => {
        scans++;
        return new Promise((resolve) => {
            finish = resolve;
        });
    };
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/util/handlers/ScheduledMessages.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            console,
            setTimeout: (run) => {
                const timer = { run };
                timers.push(timer);
                return timer;
            },
            setInterval: (run) => {
                const timer = { run };
                timers.push(timer);
                return timer;
            },
            clearTimeout: (timer) => cleared.push(timer),
            clearInterval: (timer) => cleared.push(timer),
            require: (name) => {
                if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
                if (name === "../../../util/util/ProcessLifecycle") return { ProcessLifecycle: lifecycle };
                if (name === "@spacebar/database")
                    return {
                        ScheduledMessageState: { SCHEDULED: 0 },
                        ScheduledMessage: { createQueryBuilder: () => query },
                        getDatabase: () => {
                            dispatches++;
                            return {};
                        },
                    };
                if (["@spacebar/util", "@spacebar/schemas", "./DirectMessage", "./UserMessage", "../utility/automod", "./ScheduledMessageDispatch"].includes(name)) return {};
                throw Error(name);
            },
        },
    );
    const api = module.exports;
    const timer = api.startScheduledMessageSender();
    assert.equal(api.startScheduledMessageSender(), timer);
    assert.equal(timers.length, 2);
    const pending = api.sendDueScheduledMessages();
    let drained = false;
    const stop = lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => {
            drained = true;
        });
    timers.forEach(({ run }) => run());
    assert.equal(scans, 1);
    await Promise.resolve();
    assert.equal(drained, false);
    finish([{ id: "1" }, { id: "2" }]);
    await pending;
    await stop;
    await api.sendDueScheduledMessages();
    assert.equal(dispatches, 0);
    assert.equal(scans, 1);
    assert.deepEqual(cleared, timers);
});
