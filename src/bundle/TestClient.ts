import express, { Application, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ClientAssetCompression, clientAssetVersion } from "./ClientAssetCompression";
import { compressedStatic } from "../util/util/CompressedStatic";
import {
    APP_THEME_COLOR,
    appIconPng,
    appIconUrl,
    appManifest,
    brandImageUrls,
    brandPage,
    clanBadgeColorCount,
    clanBadgePack,
    Config,
    CUSTOM_CLAN_BADGE_PACK,
    CUSTOM_CLAN_BADGES,
    DEFAULT_ICON_FILE,
    DEFAULT_FAVICON_FILE,
    helpUrl,
    instanceIcon,
    instanceIconDataUri,
    placeholderAvatarSvg,
    qrLogoSvg,
    sendBrandImage,
    wordmarkSvg,
} from "@spacebar/util";

const ASSET_FOLDER_PATH = path.join(__dirname, "..", "..", "assets");
const CACHE_PATH = path.join(ASSET_FOLDER_PATH, "cache");
const COMPRESSED_PATH = process.env.CLIENT_COMPRESSED_PATH ? path.resolve(process.env.CLIENT_COMPRESSED_PATH) : path.join(ASSET_FOLDER_PATH, "cache_compressed");
const PATCH_PATH = path.join(ASSET_FOLDER_PATH, "client_patches");
const VENCORD_PATH = path.join(ASSET_FOLDER_PATH, "vencord");
const VENCORD_SCRIPT = path.join(VENCORD_PATH, "vencord.js");
const UPSTREAM = "https://discord.com";
const DEVELOPMENT = process.env.NODE_ENV === "development";
const HASHED = /(?:^|[.-])[0-9a-f]{8,32}\.\w+$/;
const COMPRESSIBLE = /\.(js|css|json|svg|wasm)$/;
const PRECOMPRESSED: Record<string, string> = { br: "br", gzip: "gz" };

const acceptedEncodings = (header = "") => {
    const weights = new Map<string, number>();
    for (const part of header.toLowerCase().split(",")) {
        const [name, ...params] = part.split(";").map((x) => x.trim());
        const q = params.find((x) => x.startsWith("q="));
        if (name) weights.set(name, q ? Number(q.slice(2)) : 1);
    }
    const weight = (encoding: string) => weights.get(encoding) ?? weights.get("*") ?? 0;
    return ["br", "zstd", "gzip"].filter((x) => weight(x) > 0).sort((a, b) => weight(b) - weight(a));
};

const compressor = (encoding: string) => {
    if (encoding === "zstd") return zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 6 } });
    if (encoding === "br") return zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
    return zlib.createGzip({ level: 6 });
};

const vencordCompression = new ClientAssetCompression();

const stat = (file: string) => fs.promises.stat(file).catch(() => null);

const serveAsset = async (req: Request, res: Response, next: NextFunction, root: string, precompressed: boolean) => {
    const file = req.params.file as string;
    if (!/^\w[\w.-]*$/.test(file)) return next();
    const source = path.join(root, file);
    const sourceStat = await stat(source);
    if (!sourceStat?.isFile()) return next();

    res.set("Cache-Control", DEVELOPMENT || !precompressed || !HASHED.test(file) ? "no-cache" : "public, max-age=31536000, immutable");
    res.set("Access-Control-Allow-Origin", "*");
    if (!COMPRESSIBLE.test(file)) return res.sendFile(source, { cacheControl: false, dotfiles: "allow" });

    res.vary("Accept-Encoding");
    res.type(path.extname(file));
    const encodings = acceptedEncodings(req.headers["accept-encoding"]);
    for (const encoding of precompressed ? encodings : []) {
        if (!PRECOMPRESSED[encoding]) continue;
        const compressed = path.join(COMPRESSED_PATH, `${file}.${PRECOMPRESSED[encoding]}`);
        const compressedStat = await stat(compressed);
        if (!compressedStat || compressedStat.mtimeMs < Math.floor(sourceStat.mtimeMs)) continue;
        res.set("Content-Encoding", encoding);
        return res.sendFile(compressed, {
            cacheControl: false,
            acceptRanges: false,
            dotfiles: "allow",
        });
    }

    if (!encodings.length || sourceStat.size < 1024) return res.sendFile(source, { cacheControl: false, dotfiles: "allow" });
    res.set("Content-Encoding", encodings[0]);
    res.set("ETag", `W/"${sourceStat.size.toString(16)}-${createHash("sha1").update(clientAssetVersion(sourceStat)).digest("hex")}-${encodings[0]}"`);
    res.set("Last-Modified", sourceStat.mtime.toUTCString());
    if (req.fresh) return res.status(304).end();
    if (req.method === "HEAD") return res.end();
    if (root === VENCORD_PATH) {
        const compressed = await vencordCompression.get(source, sourceStat, encodings[0]);
        if (compressed) return res.send(compressed);
    }
    await pipeline(fs.createReadStream(source), compressor(encodings[0]), res).catch(() => res.destroy());
};

const BRANDED_ASSETS: Record<string, { wordmark?: boolean; svg: (iconUri: string | null) => string }> = {
    "131c318dd45b7aa4.svg": { wordmark: true, svg: (iconUri) => wordmarkSvg(undefined, iconUri) },
    "bbbc3d376d38e7bc.svg": { wordmark: true, svg: (iconUri) => wordmarkSvg([112, 36], iconUri) },
    "dd05fd1ea37e7747.png": { svg: qrLogoSvg },
    "d11a9f2f62494f22.png": {
        svg: (iconUri) => placeholderAvatarSvg(132, "rgb(116 126 136 / 30%)", "rgb(255 255 255 / 30%)", iconUri),
    },
    "9d8606c1376ca484.png": {
        svg: (iconUri) => placeholderAvatarSvg(128, "rgb(170 170 178 / 80%)", "#fff", iconUri),
    },
    "2ca6b6f4a73913ed.png": {
        svg: (iconUri) => placeholderAvatarSvg(128, "rgb(111 111 116 / 80%)", "rgb(191 191 193 / 90%)", iconUri),
    },
    "53728a8572402a56.png": {
        svg: (iconUri) => placeholderAvatarSvg(396, "#0c0d0e", "#444545", iconUri),
    },
};

export function TestClientAssets(app: Application) {
    const noCache = { setHeaders: (res: Response) => res.set("Cache-Control", "no-cache") };
    app.get(
        ["/assets/favicon.ico", "/favicon.ico", "/assets/favicon.svg", "/favicon.svg"],
        (req, res) => void sendBrandImage(res, instanceIcon() ?? { file: DEFAULT_FAVICON_FILE }, "no-cache"),
    );
    app.get(["/manifest.webmanifest", "/manifest.json"], (req, res) => {
        res.set("Cache-Control", "no-cache");
        res.type("application/manifest+json").send(JSON.stringify(appManifest()));
    });
    app.get("/assets/pwa/:file", async (req, res) => {
        const size = Number(/^icon-(180|192|512)\.png$/.exec(req.params.file as string)?.[1]);
        if (!size) return res.sendStatus(404);
        const png = await appIconPng(size);
        if (!png) return sendBrandImage(res, instanceIcon() ?? { file: DEFAULT_ICON_FILE }, "no-cache");
        res.set("Cache-Control", "public, max-age=21600").type("png").send(png);
    });
    app.get("/assets/:file", async (req, res, next) => {
        const branded = BRANDED_ASSETS[req.params.file as string];
        if (!branded) return next();
        res.set("Cache-Control", "no-cache");
        const logo = branded.wordmark && brandImageUrls().logo;
        if (logo) return res.redirect(302, logo);
        res.type("image/svg+xml").send(branded.svg(await instanceIconDataUri()));
    });
    app.get("/e2ee-sw.js", (req, res) => {
        res.set({ "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" });
        return res.type("js").sendFile(path.join(ASSET_FOLDER_PATH, "public", "e2ee", "sw.js"), {
            cacheControl: false,
            dotfiles: "allow",
        });
    });
    app.get("/notifications-sw.js", (req, res) => {
        res.set("Cache-Control", "no-cache");
        return res.type("js").sendFile(path.join(ASSET_FOLDER_PATH, "public", "notifications", "sw.js"), {
            cacheControl: false,
            dotfiles: "allow",
        });
    });
    app.get("/e2ee/attachments/{*splat}", (req, res) => res.status(404).type("txt").send("This content is no longer available."));
    app.use("/assets", compressedStatic(path.join(ASSET_FOLDER_PATH, "public")), express.static(path.join(ASSET_FOLDER_PATH, "public")));
    app.get("/assets/vencord/:file", (req, res, next) => void serveAsset(req, res, next, VENCORD_PATH, false).catch(next));
    app.use("/assets/vencord", express.static(VENCORD_PATH, noCache));
    app.use("/vendor/monaco", express.static(path.join(VENCORD_PATH, "vendor", "monaco"), noCache));
    const manifestPath = path.join(CACHE_PATH, "release-manifest.json");
    const reviewedAssets = new Set<string>(fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).assets : []);
    app.get("/assets/:file", (req, res, next) => {
        if (/\.(?:js|css|wasm)$/.test(req.params.file as string) && !reviewedAssets.has(req.params.file as string)) return res.sendStatus(404);
        return void serveAsset(req, res, next, CACHE_PATH, true).catch(next);
    });
}

const ENDPOINT_KEYS = [
    "API_ENDPOINT",
    "API_PROTOCOL",
    "GATEWAY_ENDPOINT",
    "GATEWAY_ALT_ENDPOINT",
    "ASSET_ENDPOINT",
    "MEDIA_PROXY_ENDPOINT",
    "IMAGE_PROXY_ENDPOINTS",
    "CDN_HOST",
    "DEVELOPERS_ENDPOINT",
    "MARKETING_ENDPOINT",
    "WEBAPP_ENDPOINT",
    "WIDGET_ENDPOINT",
    "INVITE_HOST",
    "GUILD_TEMPLATE_HOST",
    "GIFT_CODE_HOST",
    "PRIMARY_DOMAIN",
    "REMOTE_AUTH_ENDPOINT",
    "RTC_LATENCY_ENDPOINT",
    "MIGRATION_SOURCE_ORIGIN",
    "MIGRATION_DESTINATION_ORIGIN",
    "ACTIVITY_APPLICATION_HOST",
];

const buildHtml = () => {
    const source = fs.readFileSync(path.join(CACHE_PATH, "index.html"), "utf8");
    const { client } = Config.get();

    const envMatch = source.match(/<script[^>]*>\s*window\.GLOBAL_ENV\s*=([\s\S]*?)<\/script>/);
    if (!envMatch) throw new Error("[TestClient] assets/cache/index.html has no GLOBAL_ENV, rerun `bun run generate:client`");
    const sandbox: { window: { GLOBAL_ENV?: Record<string, unknown> } } = { window: {} };
    vm.runInNewContext(`window.GLOBAL_ENV =${envMatch[1]}`, sandbox);
    const base = sandbox.window.GLOBAL_ENV ?? {};
    for (const key of ENDPOINT_KEYS) delete base[key];

    const images = brandImageUrls();
    const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

    const env = `<script>
(() => {
    const host = location.host;
    const secure = location.protocol === "https:";
    const cdn = host;
    const gateway = \`\${secure ? "wss" : "ws"}://\${host}\`;
    window.GLOBAL_ENV = Object.assign(${JSON.stringify(base)}, {
        HTML_TIMESTAMP: Date.now(),
        API_ENDPOINT: \`//\${host}/api\`,
        API_PROTOCOL: location.protocol,
        GATEWAY_ENDPOINT: gateway,
        GATEWAY_ALT_ENDPOINT: gateway,
        ASSET_ENDPOINT: \`//\${host}\`,
        MEDIA_PROXY_ENDPOINT: \`//\${cdn}\`,
        IMAGE_PROXY_ENDPOINTS: \`//\${host}\`,
        CDN_HOST: cdn,
        DEVELOPERS_ENDPOINT: \`//\${host}\`,
        MARKETING_ENDPOINT: \`//\${host}\`,
        WEBAPP_ENDPOINT: \`//\${host}\`,
        WIDGET_ENDPOINT: \`//\${host}/widget\`,
        INVITE_HOST: \`\${host}/invite\`,
        GUILD_TEMPLATE_HOST: \`\${host}/template\`,
        GIFT_CODE_HOST: \`\${host}/gift\`,
        PRIMARY_DOMAIN: host,
        REMOTE_AUTH_ENDPOINT: \`\${secure ? "wss" : "ws"}://\${host}/remote-auth\`,
        RTC_LATENCY_ENDPOINT: \`//\${host}/rtc\`,
        MIGRATION_SOURCE_ORIGIN: location.origin,
        MIGRATION_DESTINATION_ORIGIN: location.origin,
        WEBAUTHN_ORIGIN: location.hostname,
        ACTIVITY_APPLICATION_HOST: ${json(client.activityApplicationHost ?? "")} || \`//\${host}\`,
        LOADING_TIPS: ${json(client.loadingTips)},
        LOADING_SVG: ${json(client.loadingSvg)},
        INSTANCE_NAME: ${json(client.instanceName)},
        INSTANCE_ICON: ${json(images.icon)},
        INSTANCE_LOGO: ${json(images.logo)},
        HELP_URL: ${json(helpUrl())},
        SLOWMODE_ALLOW_BYPASS: ${json(Config.get().limits.channel.allowSlowmodeBypass === true)},
        E2EE_TRUST_SERVER: ${json(Config.get().limits.e2ee.trustServerByDefault !== false)},
        PRIVATE_ENCRYPTION_DEFAULT: true,
        GROUP_DM_RECIPIENT_LIMIT: ${json(Config.get().limits.channel.maxGroupDmRecipients)},
        REGISTER_EMAIL_REQUIRED: ${json(Config.get().register.email.required === true)},
        CUSTOM_CLAN_BADGE_PACK: ${json(CUSTOM_CLAN_BADGE_PACK)},
        CUSTOM_CLAN_BADGES: ${json(CUSTOM_CLAN_BADGES.map((badge) => ({ ...badge, pack: clanBadgePack(badge), colors: clanBadgeColorCount(badge) })))},
    });
})();
</script>`;

    const patches = fs.existsSync(PATCH_PATH)
        ? fs
              .readdirSync(PATCH_PATH)
              .filter((x) => x.endsWith(".js"))
              .sort()
              .map((x) => `<script>${fs.readFileSync(path.join(PATCH_PATH, x), "utf8")}</script>`)
              .join("\n")
        : "";

    const vencord = fs.existsSync(VENCORD_SCRIPT)
        ? `<script src="/assets/vencord/vencord.js?v=${createHash("sha256").update(fs.readFileSync(VENCORD_SCRIPT)).digest("hex").slice(0, 12)}"></script>`
        : "";
    const title = client.instanceName.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const appMeta = [
        `<link rel="icon" href="/favicon.svg">`,
        `<link rel="manifest" href="/manifest.webmanifest">`,
        `<meta name="theme-color" content="${APP_THEME_COLOR}">`,
        `<meta name="mobile-web-app-capable" content="yes">`,
        `<meta name="apple-mobile-web-app-capable" content="yes">`,
        `<meta name="apple-mobile-web-app-status-bar-style" content="black">`,
        `<meta name="apple-mobile-web-app-title" content="${title}">`,
        `<link rel="apple-touch-icon" href="${appIconUrl(180)}">`,
    ].join("\n    ");

    if (!vencord) console.warn("[TestClient] assets/vencord/vencord.js is missing, run `bun run build:vencord` to build the client mods");

    return source
        .replace(envMatch[0], `${env}\n${vencord}\n${patches}`)
        .replace(/<script[^>]*>[^<]*__CF\$cv\$params[\s\S]*?<\/script>/, "")
        .replace(/<script[^>]*src="\/assets\/sentry\.[0-9a-f]+\.js"[^>]*><\/script>\s*/g, "")
        .replace(/<link[^>]*href="\/assets\/sentry\.[0-9a-f]+\.js"[^>]*>\s*/g, "")
        .replace(/ nonce="[^"]*"/g, "")
        .replace(/<link rel="preconnect"[^>]*>\s*/g, "")
        .replace(/<!-- section:seometa -->[\s\S]*?<!-- endsection -->/, "")
        .replace(
            /<meta content="[^"]*" name="viewport">/,
            '<meta content="width=device-width, initial-scale=1, maximum-scale=3, interactive-widget=resizes-content" name="viewport">',
        )
        .replace(/<link[^>]*rel="(?:shortcut )?icon"[^>]*>/g, "")
        .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>\n    ${appMeta}`)
        .replace(
            "</body>",
            `<footer id="meowcord-credit" hidden>this instance is running <a href="https://github.com/meowcorded/meowcord">meowcord</a>!</footer><script src="/assets/meowcord-credit.js"></script></body>`,
        );
};

const EXTRA_ROOTS = ["", "ra"];

const clientRoots = () => {
    const html = fs.readFileSync(path.join(CACHE_PATH, "index.html"), "utf8");
    const entry = html.match(/src="\/assets\/(web\.[0-9a-f]+\.js)"/)?.[1];
    if (!entry) return null;
    const source = fs.readFileSync(path.join(CACHE_PATH, entry), "utf8");
    const start = source.indexOf('Object.freeze({INDEX:"/",');
    if (start === -1) return null;
    let depth = 0;
    let end = start;
    for (let i = source.indexOf("{", start); i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && !--depth) {
            end = i;
            break;
        }
    }
    const roots = new Set(EXTRA_ROOTS);
    for (const [, root] of source.slice(start, end).matchAll(/[`"]\/([\w@.-]*)/g)) roots.add(root.toLowerCase());
    return roots.size > EXTRA_ROOTS.length ? roots : null;
};

const renderNotFound = () => brandPage(fs.readFileSync(path.join(ASSET_FOLDER_PATH, "public", "not-found.html"), "utf8"));

const renderPage = () => {
    const body = Buffer.from(buildHtml());
    return {
        body,
        etag: `"${createHash("sha1").update(body).digest("base64url")}"`,
        br: zlib.brotliCompressSync(body, {
            params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
                [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            },
        }),
        gzip: zlib.gzipSync(body, { level: 9 }),
    };
};

export default function TestClient(app: Application) {
    if (!Config.get().client.useTestClient || !fs.existsSync(path.join(CACHE_PATH, "index.html"))) return;
    require(path.resolve(__dirname, "../../scripts/client-release.js")).check(CACHE_PATH);

    const brandStamp = () =>
        JSON.stringify([
            Config.get().client,
            brandImageUrls(),
            helpUrl(),
            Config.get().limits.channel.maxGroupDmRecipients,
            Config.get().limits.channel.allowSlowmodeBypass,
            Config.get().limits.e2ee.trustServerByDefault,
            Config.get().register.email.required,
        ]);
    let brand = brandStamp();
    let page = renderPage();
    let roots = clientRoots();
    const missLog = path.join(ASSET_FOLDER_PATH, "cacheMisses");

    app.get("/assets/version.:channel.json", (req, res) => {
        const hash = fs.readFileSync(path.join(CACHE_PATH, "index.html"), "utf8").match(/"VERSION_HASH":"(\w+)"/)?.[1];
        res.set("Cache-Control", "no-cache").json({ hash, required: false });
    });

    app.get("/assets/:file", async (req, res) => {
        const file = req.params.file;
        if (!/^[\w.-]+$/.test(file) || /\.(?:map|js|css|wasm)$/.test(file)) return res.sendStatus(404);
        if (!Config.get().externalRequests.discordClientAssets) return res.sendStatus(404);
        const upstream = await fetch(`${UPSTREAM}/assets/${file}`, {
            signal: AbortSignal.timeout(15000),
            redirect: "error",
        }).catch(() => null);
        if (!upstream?.ok) return res.sendStatus(upstream?.status ?? 502);
        const contentType = upstream.headers.get("content-type");
        if (contentType) res.type(contentType);
        fs.promises.appendFile(missLog, `${file}\n`).catch(() => {});
        const body = Buffer.from(await upstream.arrayBuffer());
        await fs.promises.writeFile(path.join(CACHE_PATH, file), body).catch(() => {});
        res.send(body);
    });

    const sourceStamp = () =>
        [path.join(CACHE_PATH, "index.html"), PATCH_PATH, VENCORD_SCRIPT, ...(fs.existsSync(PATCH_PATH) ? fs.readdirSync(PATCH_PATH).map((x) => path.join(PATCH_PATH, x)) : [])]
            .map((x) => fs.statSync(x, { throwIfNoEntry: false })?.mtimeMs ?? 0)
            .join();
    let stamp = DEVELOPMENT ? sourceStamp() : "";

    app.get("/gift/:code", (req, res) => res.redirect(`/gifts/${encodeURIComponent(req.params.code)}`));

    app.get("/{*splat}", (req, res, next) => {
        if (/^\/(api|cdn|attachments|avatars|icons|banners|emojis|stickers|imageproxy)\b/.test(req.path)) return next();
        const sourceChanged = DEVELOPMENT && stamp !== (stamp = sourceStamp());
        if (sourceChanged) roots = clientRoots();
        if (sourceChanged || brand !== (brand = brandStamp())) page = renderPage();
        if (roots && !roots.has(req.path.split("/")[1].toLowerCase())) return res.status(404).set("Cache-Control", "no-cache").type("html").send(renderNotFound());
        res.set({ "Cache-Control": "no-cache", ETag: page.etag });
        res.vary("Accept-Encoding");
        res.type("html");
        if (req.fresh) return res.status(304).end();
        const encoding = acceptedEncodings(req.headers["accept-encoding"]).find((x) => x === "br" || x === "gzip") as "br" | "gzip" | undefined;
        if (encoding) res.set("Content-Encoding", encoding);
        res.send(encoding ? page[encoding] : page.body);
    });
}
