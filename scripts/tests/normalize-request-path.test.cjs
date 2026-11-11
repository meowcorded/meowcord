const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadModule } = require("./helpers/route-harness.cjs");

const middleware = loadModule("src/api/middlewares/NormalizeRequestPath.ts", {});

function normalize(url) {
    const req = { url, originalUrl: url };
    let calls = 0;
    middleware.normalizeRequestPath(req, {}, () => calls++);
    assert.equal(calls, 1);
    return req;
}

test("leading duplicate slashes collapse to one", () => {
    for (const [before, after] of [
        ["//api/v9/auth/login", "/api/v9/auth/login"],
        ["///api/v9/auth/login", "/api/v9/auth/login"],
        ["//", "/"],
        ["//api/v9?x=1", "/api/v9?x=1"],
    ]) {
        const req = normalize(before);
        assert.equal(req.url, after);
        assert.equal(req.originalUrl, after);
    }
});

test("middle slashes, trailing slashes and percent encoding are left alone", () => {
    for (const url of ["/api//v9/auth/login", "/api/v9/auth/login/", "/api/v9/auth/%6cogin"]) {
        const req = normalize(url);
        assert.equal(req.url, url);
        assert.equal(req.originalUrl, url);
    }
});
