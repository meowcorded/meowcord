const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const loadEmail = (brand = {}) => {
    const logs = [];
    const files = [];
    const module = { exports: {} };
    const imports = {
        "node:fs/promises": {
            readFile: async (name) => {
                files.push(name);
                return "<title>Test email</title>{actionUrl}";
            },
        },
        "node:path": path,
        "../../../database/entities": {},
        "../Config": {
            Config: { get: () => ({ email: {}, general: { instanceName: "Local test instance", serverName: "https://instance.invalid" }, api: {} }) },
        },
        "../Branding": {
            emailImageUrls: () => ({ icon: "/static/email/icon.png?v=5e6f7a8b", logo: brand.logo ?? null }),
            instanceName: () => brand.name ?? "Local test instance",
        },
        "node:crypto": {},
        jsonwebtoken: {},
        "../Token": {},
        "./clients/SendGridEmailClient": {},
        "./clients/SMTPEmailClient": {},
        "./clients/MailGunEmailClient": {},
        "./clients/MailJetEmailClient": {},
    };
    vm.runInNewContext(
        ts.transpileModule(fs.readFileSync("src/util/util/email/index.ts", "utf8"), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        }).outputText,
        {
            module,
            exports: module.exports,
            __dirname: path.resolve("src/util/util/email"),
            URL,
            console: { log: (value) => logs.push(value) },
            require: (name) => {
                assert.ok(name in imports, name);
                return imports[name];
            },
        },
    );
    return { ...module.exports, logs, files };
};
test("absent mail transport skips verification/reset/password-change without creating or logging secrets", async () => {
    const { Email, MailTypes, logs, files } = loadEmail();
    Email.generateLink = async () => {
        throw new Error("Do not generate a secret when no email can be delivered");
    };
    const user = {
        id: "fixture-user",
        email: "private@example.invalid",
        username: "Private fixture",
    };
    for (const type of Object.values(MailTypes)) await Email.sendMail(type, user, user.email);
    assert.equal(logs.length, 3);
    assert.equal(files.length, 0);
    for (const log of logs) {
        assert.match(log, /fixture-user/);
        assert.ok(!log.includes(user.email));
        assert.ok(!log.includes(user.username));
        assert.ok(!log.includes("http"));
        assert.ok(!log.includes("token="));
    }
});
test("configured mail transport still delivers action link in message without logging it", async () => {
    const { Email, MailTypes, logs } = loadEmail();
    const messages = [];
    Email.transporter = { sendMail: async (message) => messages.push(message) };
    Email.generateLink = async () => "https://instance.invalid/reset#token=fixture-secret";
    await Email.sendMail(MailTypes.resetPassword, { id: "fixture-user" }, "recipient@example.invalid");
    assert.equal(messages.length, 1);
    assert.ok(messages[0].html.includes("fixture-secret"));
    assert.ok(messages[0].text.includes("fixture-secret"));
    assert.equal(logs.length, 0);
});
test("html templates carry the instance wordmark placeholder and no fixed logo", () => {
    const folder = path.join("assets", "email_templates");
    const templates = fs.readdirSync(folder).filter((name) => name.endsWith(".html"));
    assert.equal(templates.length, 5);
    for (const name of templates) {
        const template = fs.readFileSync(path.join(folder, name), "utf8");
        assert.equal(template.split("{instanceWordmark}").length, 2, name);
        assert.ok(!/<img|spacebar/i.test(template), name);
    }
});
test("configured wordmark logo heads the email with the instance name as alt text", () => {
    const { Email } = loadEmail({ logo: "/static/email/wordmark.png?v=1a2b3c4d", name: 'Cats & "Dogs"' });
    const html = Email.doReplacements("{instanceWordmark}", { id: "fixture-user" });
    assert.match(html, /^<img src="https:\/\/instance\.invalid\/static\/email\/wordmark\.png\?v=1a2b3c4d" alt="Cats &#38; &#34;Dogs&#34;" /);
    assert.ok(!html.includes("icon.png"));
    assert.ok(!html.includes("<span"));
});
test("without a wordmark logo the email is headed by the instance icon and name", () => {
    const { Email } = loadEmail({ name: "<Cats>" });
    const html = Email.doReplacements("{instanceWordmark}", { id: "fixture-user" });
    assert.ok(html.includes('<img src="https://instance.invalid/static/email/icon.png?v=5e6f7a8b" alt=""'));
    assert.match(html, /<span [^>]*>&#60;Cats&#62;<\/span>/);
    assert.ok(!html.includes("wordmark.png"));
});
