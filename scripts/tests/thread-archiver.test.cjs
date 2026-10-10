const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
function fixture(scan) {
    const query = { where: () => query, andWhere: () => query, getMany: scan };
    const timers = [],
        errors = [];
    const module = { exports: {} };
    const lifecycle = { eventEmitter: new (require("node:events").EventEmitter)() };
    const cleared = [];
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/api/util/handlers/Thread.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            module,
            exports: module.exports,
            setTimeout: (run) => timers.push(run),
            setInterval: (run) => {
                timers.push(run);
                return "timer";
            },
            clearTimeout: (timer) => cleared.push(timer),
            clearInterval: (timer) => cleared.push(timer),
            console: { error: (...args) => errors.push(args) },
            require: (name) => {
                if (name === "@spacebar/database/Sql") return require("../../dist/database/Sql.js");
                if (name === "../../../util/util/ProcessLifecycle") return { ProcessLifecycle: lifecycle };
                if (name === "@spacebar/database") return { Channel: { createQueryBuilder: () => query } };
                if (name === "@spacebar/schemas")
                    return {
                        ChannelType: {
                            GUILD_NEWS_THREAD: 10,
                            GUILD_PUBLIC_THREAD: 11,
                            GUILD_PRIVATE_THREAD: 12,
                        },
                    };
                if (["typeorm", "@spacebar/util", "lambert-server/HTTPError"].includes(name)) return {};
                throw Error(name);
            },
        },
    );
    return { api: module.exports, timers, errors, lifecycle, cleared };
}
test("thread archiver shares one pending scan across direct and timer calls", async () => {
    let resolve,
        scans = 0;
    const h = fixture(() => {
        scans++;
        return new Promise((done) => {
            resolve = done;
        });
    });
    assert.equal(h.api.startThreadArchiver(), "timer");
    const first = h.api.archiveInactiveThreads();
    const calls = Array.from({ length: 20 }, () => h.api.archiveInactiveThreads());
    assert.ok(calls.every((pending) => pending === first));
    const scheduled = h.timers.map((run) => run());
    assert.equal(scans, 1);
    resolve([]);
    await Promise.all([first, ...calls, ...scheduled]);
    assert.equal(scans, 1);
    const next = h.api.archiveInactiveThreads();
    assert.equal(scans, 2);
    resolve([]);
    await next;
    assert.equal(h.errors.length, 0);
});
test("thread archiver releases the pending scan after a database failure", async () => {
    let reject,
        scans = 0;
    const h = fixture(() => {
        scans++;
        return scans === 1
            ? new Promise((_resolve, fail) => {
                  reject = fail;
              })
            : Promise.resolve([]);
    });
    h.api.startThreadArchiver();
    const scheduled = h.timers[0]();
    const pending = h.api.archiveInactiveThreads();
    const failure = assert.rejects(pending, /database unavailable/);
    reject(Error("database unavailable"));
    await Promise.all([scheduled, failure]);
    assert.equal(h.errors.length, 1);
    await h.api.archiveInactiveThreads();
    assert.equal(scans, 2);
});

test("thread archiver cancels both timers and drains its pending scan on shutdown", async () => {
    let finish;
    let scans = 0;
    const h = fixture(() => {
        scans++;
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    assert.equal(h.api.startThreadArchiver(), "timer");
    assert.equal(h.api.startThreadArchiver(), "timer");
    assert.equal(h.timers.length, 2);
    const work = h.api.archiveInactiveThreads();
    let drained = false;
    const stop = h.lifecycle.eventEmitter
        .listeners("stopping")[0]()
        .then(() => {
            drained = true;
        });
    await Promise.resolve();
    assert.equal(drained, false);
    h.timers.forEach((run) => run());
    assert.equal(scans, 1);
    finish([]);
    await work;
    await stop;
    await h.api.archiveInactiveThreads();
    assert.equal(scans, 1);
    assert.equal(h.cleared.length, 2);
    assert.equal(h.errors.length, 0);
});
