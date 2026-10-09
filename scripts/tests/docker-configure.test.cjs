const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function configure(environment = {}, existing = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meowcord-docker-configure-"));
    const file = path.join(directory, "config.json");
    try {
        fs.writeFileSync(file, JSON.stringify(existing));
        const result = spawnSync(process.execPath, [path.join(__dirname, "../docker-configure.js")], {
            cwd: directory,
            env: {
                PATH: process.env.PATH,
                CONFIG_PATH: file,
                DOMAIN: "chat.example.invalid",
                ...environment,
            },
            encoding: "utf8",
        });
        assert.equal(result.status, 0, result.stderr);
        return {
            config: JSON.parse(fs.readFileSync(file, "utf8")),
            mode: fs.statSync(file).mode & 0o777,
            stderr: result.stderr,
        };
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test("a complete Cap environment selects standalone explicitly", () => {
    const { config } = configure(
        {
            CAP_INSTANCE_URL: "https://cap.example.invalid",
            CAP_SITE_KEY: "synthetic-site",
            CAP_SECRET_KEY: "synthetic-secret",
        },
        {
            security: { captcha: { capMode: "core", enabled: true }, unrelated: true },
        },
    );
    assert.equal(config.security.captcha.capMode, "standalone");
    assert.equal(config.security.captcha.instance, "https://cap.example.invalid");
    assert.equal(config.security.captcha.sitekey, "synthetic-site");
    assert.equal(config.security.captcha.secret, "synthetic-secret");
    assert.equal(config.security.unrelated, true);
});

test("absent and partial Cap environment preserve dashboard settings", () => {
    const captcha = { enabled: true, capMode: "core", customSetting: 7 };
    for (const env of [{}, { CAP_INSTANCE_URL: "https://cap.example.invalid" }]) {
        const { config, stderr } = configure(env, { security: { captcha } });
        assert.deepEqual(config.security.captcha, captcha);
        if (env.CAP_INSTANCE_URL) assert.match(stderr, /needs CAP_INSTANCE_URL/);
    }
});

test("compose configure writes actual public API CDN gateway and voice paths", () => {
    const { config } = configure(
        {},
        {
            regions: {
                default: "local",
                available: [{ id: "local" }, { id: "remote", endpoint: "other.example.invalid/voice" }],
            },
        },
    );
    assert.equal(config.api.endpointPublic, "https://chat.example.invalid/api/v9");
    assert.equal(config.cdn.endpointPublic, "https://chat.example.invalid/");
    assert.equal(config.cdn.endpointPrivate, "http://127.0.0.1:3001/");
    assert.equal(config.gateway.endpointPublic, "wss://chat.example.invalid/");
    assert.equal(config.regions.available[0].endpoint, "chat.example.invalid/voice");
    assert.equal(config.regions.available[1].endpoint, "other.example.invalid/voice");
});

test("compose healthcheck rejects API-only startup and accepts the mounted client", async () => {
    const compose = fs.readFileSync(path.join(__dirname, "../../docker-compose.yml"), "utf8");
    const expression = compose.match(/test:[ \t]*\n\s*(\[[\s\S]*?AbortSignal\.timeout[\s\S]*?\])\s*interval:/)?.[1];
    assert.ok(expression, "Use the actual Compose healthcheck command");
    const command = JSON.parse(expression.replace(/,\s*\]$/, "]"))[3];
    const http = require("node:http");
    let clientReady = false;
    const server = http.createServer((request, response) => {
        response.statusCode = request.url === "/api/ping" || clientReady ? 200 : 404;
        response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const execute = () =>
        new Promise((resolve, reject) => {
            const { spawn } = require("node:child_process");
            const child = spawn(process.execPath, ["-e", command.replaceAll("127.0.0.1:3001", `127.0.0.1:${server.address().port}`)], { stdio: "ignore" });
            child.once("error", reject);
            child.once("exit", resolve);
        });
    try {
        assert.equal(await execute(), 1);
        clientReady = true;
        assert.equal(await execute(), 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("client initialization and server startup stop when mandatory encryption anchors fail", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../docker/entrypoint.sh"), "utf8");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meowcord-entrypoint-"));
    try {
        fs.mkdirSync(path.join(directory, "assets/cache"), { recursive: true });
        fs.mkdirSync(path.join(directory, "bin"));
        fs.mkdirSync(path.join(directory, "state"));
        fs.writeFileSync(
            path.join(directory, "entrypoint.sh"),
            source.replaceAll("/app", directory).replaceAll("/data/client", path.join(directory, "client")).replaceAll("/data/state", path.join(directory, "state")),
        );
        fs.writeFileSync(path.join(directory, "bin/bun"), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALLS"\ncase "$1" in *e2ee-anchors.js) exit "$ANCHOR_EXIT" ;; esac\n');
        fs.chmodSync(path.join(directory, "bin/bun"), 0o700);
        for (const cached of [false, true]) {
            if (cached) fs.writeFileSync(path.join(directory, "assets/cache/index.html"), "<html></html>");
            for (const mode of ["client", ...(cached ? ["server"] : [])]) {
                const calls = path.join(directory, "calls");
                fs.writeFileSync(calls, "");
                const result = spawnSync("/bin/sh", [path.join(directory, "entrypoint.sh"), mode], {
                    env: { PATH: `${directory}/bin:${process.env.PATH}`, CALLS: calls, ANCHOR_EXIT: "1" },
                    encoding: "utf8",
                });
                assert.equal(result.status, 1);
                const attempted = fs.readFileSync(calls, "utf8");
                assert.match(attempted, /e2ee-anchors/);
                assert.doesNotMatch(attempted, /compress-client|docker-configure|bundle\/start/);
            }
        }
        const calls = path.join(directory, "calls");
        fs.writeFileSync(calls, "");
        const valid = spawnSync("/bin/sh", [path.join(directory, "entrypoint.sh"), "client"], {
            env: { PATH: `${directory}/bin:${process.env.PATH}`, CALLS: calls, ANCHOR_EXIT: "0" },
            encoding: "utf8",
        });
        assert.equal(valid.status, 0);
        assert.match(fs.readFileSync(calls, "utf8"), /e2ee-anchors.js[\s\S]*compress-client.js/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("an explicit local HTTP origin keeps API CDN and gateway usable without TLS", () => {
    const { config } = configure({ DOMAIN: "http://localhost:3416/" });
    assert.equal(config.general.serverName, "http://localhost:3416");
    assert.equal(config.api.endpointPublic, "http://localhost:3416/api/v9");
    assert.equal(config.cdn.endpointPublic, "http://localhost:3416/");
    assert.equal(config.gateway.endpointPublic, "ws://localhost:3416/");
});
