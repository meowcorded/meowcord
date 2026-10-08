const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function load(globalEnv) {
    const module = { exports: {} };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("client/plugins/fosscordBranding/messages.ts", "utf8"), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        { module, exports: module.exports, window: { GLOBAL_ENV: globalEnv }, location: { host: "tabaque.lol", origin: "https://tabaque.lol" } },
    );
    return module.exports;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const help = [1, "helpUrl"];
const messages = () => ({
    SkGL7l: ["Your message could not be delivered.\n\nYou can see the full list of reasons here: ", help],
    llTkqr: [
        "Your message could not be delivered. Send a friend request first and start the conversation once they’ve accepted.\n\nHere is the full list of reasons why your message could not be delivered: ",
        help,
    ],
    zSG3Qy: ["Your message could not be delivered because this message contains a link blocked by Discord. You can learn more here: ", help, "."],
    other: ["Read more here: ", help],
});

test("without a help center the undeliverable-message texts no longer end in a dangling link", () => {
    const out = plain(load({ INSTANCE_NAME: "Tabaque" }).brandMessages(messages()));
    assert.deepEqual(out.SkGL7l, [
        "Your message could not be delivered.\n\nThis usually means you don't share a server with them, or they only accept direct messages from friends.",
    ]);
    assert.deepEqual(out.llTkqr, ["Your message could not be delivered. Send a friend request first and start the conversation once they’ve accepted."]);
    assert.deepEqual(out.zSG3Qy, ["Your message could not be delivered because this message contains a link blocked by Tabaque", "."]);
});

test("other messages that use the help link are left alone", () => {
    assert.deepEqual(plain(load({ INSTANCE_NAME: "Tabaque" }).brandMessages(messages()).other), ["Read more here: ", help]);
});

test("with a help center configured nothing is reworded", () => {
    const out = plain(load({ INSTANCE_NAME: "Tabaque", HELP_URL: "https://help.example.com" }).brandMessages(messages()));
    assert.deepEqual(out.SkGL7l, ["Your message could not be delivered.\n\nYou can see the full list of reasons here: ", help]);
});
