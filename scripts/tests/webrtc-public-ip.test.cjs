/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolvePublicIp } = require("../../dist/webrtc/util/PublicIp");

test("an address is announced as it is", async () => {
    assert.equal(await resolvePublicIp("203.0.113.10"), "203.0.113.10");
});

test("a host name is announced as its IPv4 address", async () => {
    assert.equal(await resolvePublicIp("localhost"), "127.0.0.1");
});

test("an unresolvable host name fails when the deadline passes", async () => {
    await assert.rejects(resolvePublicIp("voice.invalid", 0));
});
