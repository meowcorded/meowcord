import { createRequire } from "node:module";
import { homedir } from "node:os";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromiumPath } from "./util/chromium.cjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = (process.env.ORIGIN || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, "");
const timeout = Number(process.env.CHECK_TIMEOUT || 240) * 1000;
const reportPath = process.env.CHECK_REPORT || path.join(ROOT, "assets", "vencord", "report.json");

const assetDirectory = path.resolve(process.env.VENCORD_OUTPUT || path.join(ROOT, "assets", "vencord"));
const reporterScript = path.join(assetDirectory, "reporter.js");
if (!existsSync(reporterScript)) {
    console.error("assets/vencord/reporter.js is missing, run `bun scripts/vencord.js --reporter` first");
    process.exit(2);
}

const playwright = (() => {
    for (const base of [path.join(ROOT, "package.json"), path.join(homedir(), ".cache", "fosscord-tools", "package.json")]) {
        try {
            return createRequire(base)("playwright-core");
        } catch {
            continue;
        }
    }
    console.error("playwright-core is not installed, run `bun add -d playwright-core` or install it in ~/.cache/fosscord-tools");
    process.exit(2);
})();

const pluginDir = path.join(ROOT, "client", "plugins");
const ours = new Set(
    (existsSync(pluginDir) ? readdirSync(pluginDir) : [])
        .flatMap((dir) => ["index.ts", "index.tsx"].map((file) => path.join(pluginDir, dir, file)))
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file, "utf8").match(/definePlugin\(\{\s*name:\s*"([^"]+)"/)?.[1])
        .filter(Boolean),
);
const config = JSON.parse(readFileSync(path.join(ROOT, "client", "vencord.json"), "utf8"));
const enabled = new Set(Object.entries(config.plugins ?? {}).flatMap(([name, value]) => ((typeof value === "boolean" ? value : value.enabled) ? [name] : [])));

const ping = await fetch(`${origin}/api/v9/ping`).catch(() => null);
if (!ping?.ok) {
    console.error(`no server answering at ${origin}, start it or set ORIGIN`);
    process.exit(2);
}

const report = {
    badPatches: [],
    badFinds: [],
    badStarts: [],
    errors: [],
    unmatchedAllPatches: [],
    meta: null,
    assetFailures: [],
};

const unmatchedAllPatches = (names) => {
    const sources = Object.values(Vencord.Webpack.wreq.m).map(String);
    return names.flatMap((name) =>
        (Vencord.Plugins.plugins[name]?.patches ?? [])
            .filter((patch) => patch.all)
            .filter((patch) => !sources.some((code) => (typeof patch.find === "string" ? code.includes(patch.find) : ((patch.find.lastIndex = 0), patch.find.test(code)))))
            .map((patch) => ({ plugin: name, find: String(patch.find) })),
    );
};
const browser = await playwright.chromium.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: ["--disable-quic"],
});
const page = await browser.newPage();
await page.route(/\/assets\/vencord\/vencord\.js/, (route) => route.fulfill({ contentType: "text/javascript", body: readFileSync(reporterScript, "utf8") }));

let loadingChunks = false;
let finish;
const finished = new Promise((resolve) => (finish = resolve));
const describe = (handle) => handle.evaluate((value) => (value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value))).catch(() => "");

const pendingMessages = new Set();
const handleConsole = async (message) => {
    if (/LazyChunkLoader:.*Loading all chunks/.test(message.text())) loadingChunks = true;
    const args = message.args();
    const first = args[0] ? await describe(args[0]) : "";
    if (first === "[REPORTER_META]") {
        report.meta = JSON.parse(await describe(args[1]));
        return;
    }
    if (first !== "[Vencord]" && first !== "[Equicord]") return;
    const [tag, text, extra] = await Promise.all(args.slice(1, 4).map(describe));
    if (tag === "WebpackPatcher:") {
        const failure = text.match(/Patch by (.+?) (had no effect|errored|found no module) \(Module id is (.+?)\): ([\s\S]+)/);
        if (failure)
            report.badPatches.push({
                plugin: failure[1],
                type: failure[2],
                module: failure[3],
                match: failure[4],
                error: extra || undefined,
            });
    } else if (tag === "PluginManager:") {
        const failure = text.match(/Failed to start (.+)/);
        if (failure) report.badStarts.push({ plugin: failure[1], error: extra || "unknown error" });
    } else if (tag === "Reporter:" || tag === "LazyChunkLoader:") {
        if (text === "Webpack Find Fail:") report.badFinds.push(extra);
        else if (text === "A fatal error occurred:") {
            report.errors.push(`${tag} ${extra}`);
            finish("fatal");
        } else if (text === "Finished test") {
            report.unmatchedAllPatches = await page.evaluate(unmatchedAllPatches, [...ours]).catch((e) => [{ plugin: "check", find: String(e) }]);
            finish("done");
        }
    }
};
page.on("console", (message) => {
    if (!/^\[REPORTER_META\]|^\[(?:Vencord|Equicord)\] (?:WebpackPatcher|PluginManager|Reporter|LazyChunkLoader):/.test(message.text())) return;
    const work = handleConsole(message).catch((error) => report.errors.push(`console handler: ${error.message}`));
    pendingMessages.add(work);
    work.finally(() => pendingMessages.delete(work));
});
page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/assets/")) report.assetFailures.push({ url: url.origin + url.pathname, error: request.failure()?.errorText });
});
page.on("response", (response) => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname.startsWith("/assets/")) report.assetFailures.push({ url: url.origin + url.pathname, status: response.status() });
});
page.on("pageerror", (error) => {
    if (!/Sentry successfully disabled/.test(error.message)) report.errors.push(error.message.slice(0, 300));
});

const started = Date.now();
await page.goto(`${origin}/login`);
await page.waitForFunction(() => typeof window.Vencord?.Webpack?._initReporter === "function" && typeof window.Vencord?.Webpack?.wreq === "function", null, { timeout });
if (!loadingChunks)
    await page.evaluate(() => {
        Vencord.Webpack._initReporter();
    });
const outcome = await Promise.race([finished, new Promise((resolve) => setTimeout(() => resolve("timeout"), timeout))]);
while (pendingMessages.size) await Promise.allSettled([...pendingMessages]);
await browser.close().catch(() => {});

const owner = (plugin) => (ours.has(plugin) ? "fosscord" : enabled.has(plugin) ? "enabled" : "upstream");
const findOwner = (find) => [...ours].find((name) => find.includes(name));
writeFileSync(reportPath, JSON.stringify({ outcome, origin, seconds: Math.round((Date.now() - started) / 1000), ...report }, null, 4));

const groups = { fosscord: [], enabled: [], upstream: [] };
for (const patch of report.badPatches)
    groups[owner(patch.plugin)].push(`${patch.plugin}: patch ${patch.type}\n      ${patch.match.slice(0, 220)}${patch.error ? `\n      ${patch.error.slice(0, 220)}` : ""}`);
for (const start of report.badStarts) groups[owner(start.plugin)].push(`${start.plugin}: failed to start\n      ${start.error.slice(0, 220)}`);
for (const patch of report.unmatchedAllPatches) groups.fosscord.push(`${patch.plugin}: patch found no module\n      ${patch.find.slice(0, 220)}`);
for (const find of report.badFinds) groups[findOwner(find) ? "fosscord" : "upstream"].push(`webpack find failed\n      ${find.slice(0, 220)}`);

console.log(`Client patch check against ${origin} (${outcome}, ${Math.round((Date.now() - started) / 1000)}s, build ${report.meta?.buildNumber ?? "unknown"})`);
for (const [group, title] of [
    ["fosscord", "Fosscord plugins"],
    ["enabled", "Upstream plugins enabled by default"],
    ["upstream", "Other upstream plugins (disabled by default, informational)"],
]) {
    console.log(`\n${title}: ${groups[group].length ? `${groups[group].length} problem(s)` : "ok"}`);
    for (const line of groups[group]) console.log(`  - ${line}`);
}
if (report.errors.length) console.log(`\nPage errors:\n${[...new Set(report.errors)].map((e) => `  - ${e}`).join("\n")}`);
if (report.assetFailures.length) console.log(`\nAsset failures:\n${report.assetFailures.map((failure) => `  - ${failure.status ?? failure.error} ${failure.url}`).join("\n")}`);
console.log(`\nFull report written to ${path.relative(ROOT, reportPath)}`);

if (outcome !== "done") {
    console.error(`\nThe reporter did not finish (${outcome}).`);
    process.exit(1);
}
process.exit(groups.fosscord.length || groups.enabled.length || report.errors.some((error) => error.startsWith("console handler:")) ? 1 : 0);
