const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const load = (file, imports = {}) => {
    const module = { exports: {} };
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, {
        module,
        exports: module.exports,
        require: (name) => {
            if (name in imports) return imports[name];
            return require(name);
        },
    });
    return module.exports;
};

const ansi = load("src/util/util/ColorUtils.ts");
const strings = load("src/extensions/String.ts", {
    "@spacebar/util/util/Regex": load("src/util/util/Regex.ts"),
    "@spacebar/extensions": {},
});

test("ansi styles emit escape sequences and reset", () => {
    assert.equal(ansi.styleAnsiText("hi", { foreground: ansi.AnsiForeground.Red }), "\u001b[31mhi\u001b[0m");
    assert.equal(ansi.styleAnsiText("hi", { format: ansi.AnsiFormat.Bold, foreground: ansi.AnsiForeground.Green }), "\u001b[1;32mhi\u001b[0m");
    assert.equal(ansi.truecolorAnsiText("hi", 255, 0, 0), "\u001b[38;2;255;0;0mhi\u001b[0m");
    assert.equal(ansi.styleAnsiText("plain", {}), "plain");
});

test("ansi detection and stripping round-trips", () => {
    const styled = ansi.truecolorAnsiText("Test", 255, 0, 0);
    assert.equal(ansi.containsAnsiSequences(styled), true);
    assert.equal(ansi.stripAnsiSequences(styled), "Test");
    assert.equal(ansi.containsAnsiSequences("plain"), false);
});

test("message content normalizes carriage returns before storage", () => {
    assert.equal(strings.normalizeLineEndings("a\r\nb\rc\nd"), "a\nb\nc\nd");
    assert.equal(strings.normalizeLineEndings(""), "");
    assert.equal(strings.normalizeLineEndings(undefined), "");
    const crlf = "```ansi\r\n\u001b[31mRed\u001b[0m\r\n```";
    const stored = strings.normalizeLineEndings(crlf).trim();
    assert.match(stored, /^```ansi\n/);
    assert.equal(stored.includes("\r"), false);
    assert.equal(ansi.containsAnsiSequences(stored), true);
});
test("ansi code blocks and message transport preserve escapes", () => {
    const body = `${ansi.truecolorAnsiText("Red", 255, 0, 0)} ${ansi.styleAnsiText("Bold", { format: ansi.AnsiFormat.Bold })}`;
    const fenced = ansi.wrapAnsiCodeBlock(body);
    assert.match(fenced, /^```ansi\n/);
    assert.match(fenced, /```$/);
    const transported = JSON.parse(JSON.stringify({ content: fenced })).content.trim();
    assert.equal(transported, fenced);
    assert.equal(ansi.containsAnsiSequences(transported), true);
    assert.equal(ansi.stripAnsiSequences(transported).includes("Red"), true);
});
