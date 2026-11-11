const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const MessageComponentType = { ActionRow: 1, Section: 9, TextDisplay: 10, Thumbnail: 11, MediaGallery: 12, File: 13, Container: 17 };
const EmbedType = { rich: "rich", image: "image", video: "video", gifv: "gifv", article: "article", link: "link" };
const settings = {
    cdn: { endpointPublic: "https://instance.test" },
    security: { requestSignature: "fixture-signature" },
    externalRequests: { thirdParty: true },
    limits: { message: { maxEmbedDownloadSize: 1024 * 1024, maxEmbeds: 10 } },
    embeds: { youtube: {} },
    external: {},
};
const Config = { get: () => settings };

const load = (file, imports, globals = {}) => {
    const module = { exports: {} };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
        module,
        exports: module.exports,
        URL,
        Buffer,
        Response,
        Headers,
        setTimeout,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        require: (name) => {
            if (name in imports) return imports[name];
            if (name.startsWith("node:")) return require(name);
            throw Error(`unexpected import ${name}`);
        },
        ...globals,
    });
    return module.exports;
};

const media = load("src/util/util/MediaProxy.ts", { "./Config": { Config }, "@spacebar/schemas": { MessageComponentType, EmbedType } });

const routes = new Map();
const fetched = [];
const updates = [];
const events = [];
const stored = new Map();
const cached = [];
const embeds = load("src/api/util/utility/EmbedHandlers.ts", {
    cheerio: require("cheerio"),
    "probe-image-size": async () => ({ width: 640, height: 480 }),
    "@spacebar/util/util/networking/PublicNetwork": {
        isTrustedCdnAsset: () => false,
        fetchPublicUrl: async (url, init = {}) => {
            const target = new URL(url).searchParams.get("url");
            fetched.push({ target, method: init.method ?? "GET" });
            const route = routes.get(target);
            if (!route) throw Error(`no fixture for ${target}`);
            return route(init.method ?? "GET");
        },
    },
    typeorm: { In: (values) => values },
    "@spacebar/database": {
        EmbedCache: {
            find: async () => [],
            delete: async () => {},
            create: (value) => ({
                save: async () => {
                    cached.push(value);
                    return value;
                },
            }),
        },
        Message: { findOne: async ({ where }) => stored.get(where.id), update: async (...args) => updates.push(args) },
    },
    "@spacebar/extensions": { sleep: async () => {}, arrayDistinctBy: (a) => a, arrayGroupBy: () => new Map(), normalizeUrl: (u) => u },
    "@spacebar/util": {
        ...media,
        Config,
        emitEvent: async (event) => events.push(event),
        MessageFlags: { FLAGS: { SUPPRESS_EMBEDS: 4n } },
        OrmUtils: { mergeDeep: (a, b) => ({ ...a, ...b, headers: { ...a.headers, ...b.headers } }) },
        readVideoDimensions: () => ({ width: 960, height: 540 }),
    },
    "@spacebar/schemas": { MessageComponentType, EmbedType },
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const html = (body) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const typed =
    (type, status = 200, body = "bytes") =>
    () =>
        new Response(body, { status, headers: { "content-type": type, "content-length": String(body.length) } });

test("concurrent readers share embed generation and each receive the result", async () => {
    const link = "https://media.test/concurrent.png";
    routes.set(link, typed("image/png"));
    const results = [];
    const before = cached.length;
    await Promise.all(Array.from({ length: 5 }, () => embeds.getOrUpdateEmbedCache([link], async (url, found) => results.push({ url, found }))));
    assert.equal(cached.length - before, 1);
    assert.equal(results.length, 5);
    assert.ok(results.every(({ url, found }) => url === link && found.length === 1));
});

test("local encrypted attachment URLs are not fetched as public embed images", async () => {
    const before = fetched.length;
    const result = await embeds.getOrUpdateEmbedCache(["https://instance.test/e2ee/attachments/1/2/image.png"]);
    assert.equal(result.length, 0);
    assert.equal(fetched.length, before);
});

test("a youtube link becomes an iframe player that the client opens instead of a proxied video file", async () => {
    routes.set("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DwzWxtKxD-mc", () =>
        Response.json({
            title: "The SL12 has FINALLY LAUNCHED!",
            author_name: "Lumanesence!",
            author_url: "https://www.youtube.com/@Lumanesence",
            thumbnail_url: "https://i.ytimg.com/vi/wzWxtKxD-mc/hqdefault.jpg",
        }),
    );
    routes.set("https://i.ytimg.com/vi/wzWxtKxD-mc/maxresdefault.jpg", typed("text/html", 404));
    for (const link of ["https://www.youtube.com/watch?v=wzWxtKxD-mc", "https://youtu.be/wzWxtKxD-mc", "https://www.youtube.com/shorts/wzWxtKxD-mc"]) {
        const url = new URL(link);
        const embed = media.proxyEmbedMedia(await embeds.EmbedHandlers[url.hostname](url));
        assert.equal(embed.type, "video");
        assert.deepEqual(plain(embed.video), { url: "https://www.youtube.com/embed/wzWxtKxD-mc", width: 1280, height: 720 });
        assert.match(embed.thumbnail.proxy_url, /^https:\/\/cors\.estrogen\.delivery\/\?url=.*hqdefault/);
        assert.equal(embed.provider.name, "YouTube");
    }
});

test("stored player embeds lose a proxy_url so old cached youtube embeds play again", () => {
    const stored = { type: "video", video: { url: "https://www.youtube.com/embed/wzWxtKxD-mc", proxy_url: "https://cors.estrogen.delivery/?url=x", width: 1280, height: 720 } };
    assert.deepEqual(plain(media.proxyEmbedMedia(stored).video), { url: "https://www.youtube.com/embed/wzWxtKxD-mc", width: 1280, height: 720 });
    for (const url of ["https://evil.test/embed/wzWxtKxD-mc", "http://www.youtube.com/embed/wzWxtKxD-mc", "https://www.youtube.com/watch?v=wzWxtKxD-mc"]) {
        const video = media.proxyEmbedMedia({ type: "rich", video: { url } }).video;
        assert.match(video.proxy_url, /^https:\/\/cors\.estrogen\.delivery\//, url);
    }
    assert.equal(media.isEmbedPlayerUrl("https://player.vimeo.com/video/76979871?h=8272103f6e"), true);
    assert.equal(media.isEmbedPlayerUrl("https://player.twitch.tv/?video=2093429367"), false);
});

test("direct video embeds carry a preview frame thumbnail, and old ones without it get one when read", async () => {
    routes.set("https://media.test/flower.mp4", (method) => (method === "HEAD" ? typed("video/mp4")() : typed("video/mp4", 200, "x".repeat(2048))()));
    const url = new URL("https://media.test/flower.mp4");
    const embed = await embeds.EmbedHandlers.default(url);
    assert.equal(embed.type, "video");
    assert.equal(embed.video.content_type, "video/mp4");
    assert.equal(embed.thumbnail.proxy_url, media.videoFrameUrl(url));
    const shown = media.proxyEmbedMedia(embed);
    assert.equal(shown.thumbnail.proxy_url, media.videoFrameUrl(url));
    assert.match(shown.video.proxy_url, /^https:\/\/cors\.estrogen\.delivery\//);
    const legacy = media.proxyEmbedMedia({ ...embed, thumbnail: undefined });
    assert.equal(legacy.thumbnail.proxy_url, media.videoFrameUrl(url));
    assert.equal(legacy.thumbnail.width, 960);
    assert.equal(media.proxyEmbedMedia({ type: "rich", video: { url: url.href, proxy_url: "x" } }).thumbnail, undefined);
    const spoofed = media.proxyEmbedMedia({ image: { url: "https://media.test/a.png", proxy_url: "https://instance.test/attachments/1/2/other.png" } });
    assert.match(spoofed.image.proxy_url, /^https:\/\/cors\.estrogen\.delivery\//);
});

test("pages with og:video become video embeds only for known players or real video files", async () => {
    const page = new URL("https://vimeo.com/76979871");
    assert.deepEqual(plain(embeds.pageVideo(page, { video: "https://player.vimeo.com/video/76979871?h=1", video_type: "text/html", video_width: 1280, video_height: 720 })), {
        url: "https://player.vimeo.com/video/76979871?h=1",
        width: 1280,
        height: 720,
    });
    const file = embeds.pageVideo(page, { video: "/clip.mp4", video_width: 640, video_height: 360 });
    assert.equal(file.url, "https://vimeo.com/clip.mp4");
    assert.equal(file.content_type, "video/mp4");
    assert.match(file.proxy_url, /^https:\/\/cors\.estrogen\.delivery\//);
    assert.equal(embeds.pageVideo(page, { video: "https://player.twitch.tv/?video=1", video_type: "text/html", video_width: 620, video_height: 378 }), undefined);
    assert.equal(embeds.pageVideo(page, { video: "https://player.vimeo.com/video/1", video_type: "text/html" }), undefined);

    routes.set("https://vimeo.com/76979871", (method) =>
        method === "HEAD"
            ? typed("text/html")()
            : html(`<meta property="og:title" content="The New Vimeo Player"><meta property="og:site_name" content="Vimeo">
<meta property="og:image" content="https://i.vimeocdn.com/video/1.jpg"><meta property="og:image:width" content="1280"><meta property="og:image:height" content="720">
<meta property="og:video:secure_url" content="https://player.vimeo.com/video/76979871?h=1"><meta property="og:video:type" content="text/html">
<meta property="og:video:width" content="1280"><meta property="og:video:height" content="720">`)(),
    );
    const embed = media.proxyEmbedMedia(await embeds.EmbedHandlers.default(page));
    assert.equal(embed.type, "video");
    assert.deepEqual(plain(embed.video), { url: "https://player.vimeo.com/video/76979871?h=1", width: 1280, height: 720 });
    assert.equal(embed.image, undefined);
    assert.match(embed.thumbnail.proxy_url, /vimeocdn/);
});

test("a gif page that redirects with a meta refresh is followed once on the same host", async () => {
    routes.set(
        "https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S",
        html(`<meta id="__next-page-redirect" http-equiv="refresh" content="0;url=https://giphy.com/gifs/JIX9t2j0ZTN9S"/>`),
    );
    routes.set(
        "https://giphy.com/gifs/JIX9t2j0ZTN9S",
        html(`<meta property="og:image" content="https://media2.giphy.com/media/JIX9t2j0ZTN9S/giphy.webp"><meta property="og:image:width" content="480"><meta property="og:image:height" content="480">
<meta property="og:video" content="https://media2.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4"><meta property="og:video:width" content="480"><meta property="og:video:height" content="480">`),
    );
    const embed = await embeds.EmbedHandlers["giphy.com"](new URL("https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S"));
    assert.equal(embed.type, "gifv");
    assert.equal(embed.url, "https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S");
    assert.equal(embed.video.url, "https://media2.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4");
    assert.equal(embed.thumbnail.width, 480);
    assert.equal(embeds.getMetaDescriptions(`<meta http-equiv="Refresh" content="5; URL='/next'">`).refresh, "/next");

    routes.set("https://giphy.com/gifs/offsite", (method) =>
        method === "HEAD" ? typed("text/html")() : html(`<meta http-equiv="refresh" content="0;url=https://evil.test/gifs/x"/>`)(),
    );
    fetched.length = 0;
    await embeds.EmbedHandlers["giphy.com"](new URL("https://giphy.com/gifs/offsite")).catch(() => null);
    assert.ok(!fetched.some(({ target }) => target.startsWith("https://evil.test")));
});

test("x posts without an API token are built from fxtwitter with a playable mp4 of at most 2.5 Mbps", async () => {
    settings.external.twitter = undefined;
    routes.set("https://api.fxtwitter.com/status/2104554235924815900", () =>
        Response.json({
            tweet: {
                url: "https://x.com/SpaceX/status/2104554235924815900",
                text: "Liftoff of Starship!",
                created_timestamp: 1790599805,
                likes: 34769,
                retweets: 4999,
                replies: 797,
                author: { name: "SpaceX", screen_name: "SpaceX", url: "https://x.com/SpaceX", avatar_url: "https://pbs.twimg.com/profile_images/1/a.jpg" },
                media: {
                    all: [
                        {
                            type: "video",
                            url: "https://video.twimg.com/4k.mp4",
                            thumbnail_url: "https://pbs.twimg.com/thumb.jpg",
                            width: 3840,
                            height: 2160,
                            variants: [
                                { url: "https://video.twimg.com/pl.m3u8", bitrate: 0, content_type: "application/x-mpegURL" },
                                { url: "https://video.twimg.com/360.mp4", bitrate: 832000, content_type: "video/mp4" },
                                { url: "https://video.twimg.com/720.mp4", bitrate: 2176000, content_type: "video/mp4" },
                                { url: "https://video.twimg.com/4k.mp4", bitrate: 25128000, content_type: "video/mp4" },
                            ],
                        },
                    ],
                },
            },
        }),
    );
    for (const link of ["https://x.com/SpaceX/status/2104554235924815900", "https://twitter.com/SpaceX/status/2104554235924815900?s=20"]) {
        const url = new URL(link);
        const embed = await embeds.EmbedHandlers[url.hostname](url);
        assert.equal(embed.url, "https://x.com/SpaceX/status/2104554235924815900");
        assert.equal(embed.video.url, "https://video.twimg.com/720.mp4");
        assert.equal(embed.video.content_type, "video/mp4");
        assert.match(embed.thumbnail.url, /thumb\.jpg/);
        assert.equal(embed.author.name, "SpaceX (@SpaceX)");
        assert.equal(embed.image, undefined);
    }
    assert.equal(await embeds.EmbedHandlers["x.com"](new URL("https://x.com/SpaceX")), null);
});

test("components media gets its type and size from the source, with not-found and fallback states", async () => {
    routes.set("https://media.test/a.png", typed("image/png"));
    routes.set("https://media.test/clip", typed("video/webm"));
    routes.set("https://media.test/gone.png", typed("text/html", 404));
    const image = await embeds.unfurlComponentMedia({ url: "https://media.test/a.png" });
    assert.deepEqual(plain(image), { url: "https://media.test/a.png", content_type: "image/png", width: 640, height: 480, loading_state: 2 });
    const video = await embeds.unfurlComponentMedia({ url: "https://media.test/clip" });
    assert.equal(video.content_type, "video/webm");
    assert.equal(video.width, 960);
    assert.equal((await embeds.unfurlComponentMedia({ url: "https://media.test/gone.png" })).loading_state, 3);
    settings.externalRequests.thirdParty = false;
    const offline = await embeds.unfurlComponentMedia({ url: "https://media.test/offline.mp4" });
    settings.externalRequests.thirdParty = true;
    assert.deepEqual(plain(offline), { url: "https://media.test/offline.mp4", content_type: "video/mp4", loading_state: 2 });
    assert.equal((await embeds.unfurlComponentMedia({ url: "https://media.test/unknown" })).loading_state, 3);
});

test("fillComponentMedia unfurls nested media once, saves the components and sends one update", async () => {
    updates.length = 0;
    events.length = 0;
    const local = { url: "https://instance.test/attachments/1/2/a.png", proxy_url: "https://instance.test/attachments/1/2/a.png", content_type: "image/png" };
    const message = {
        id: "1",
        channel_id: "2",
        toJSON() {
            return { id: this.id, components: media.proxyComponentsMedia(this.components) };
        },
        components: [
            {
                type: 17,
                components: [
                    { type: 9, components: [{ type: 10, content: "x" }], accessory: { type: 11, media: { url: "https://media.test/a.png" } } },
                    { type: 12, items: [{ media: { url: "https://media.test/clip" } }, { media: local }] },
                    { type: 10, content: "https://www.youtube.com/watch?v=wzWxtKxD-mc" },
                ],
            },
        ],
    };
    stored.set("1", { id: "1", components: JSON.parse(JSON.stringify(message.components)) });
    await embeds.fillComponentMedia(message);
    const [section, gallery] = message.components[0].components;
    assert.equal(section.accessory.media.content_type, "image/png");
    assert.equal(gallery.items[0].media.content_type, "video/webm");
    assert.equal(gallery.items[1].media.loading_state, undefined);
    assert.equal(updates.length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "MESSAGE_UPDATE");
    const shown = events[0].data.components[0].components[1].items[0].media;
    assert.equal(shown.proxy_url, media.externalProxyUrl(new URL("https://media.test/clip")));
    await embeds.fillComponentMedia(message);
    assert.equal(updates.length, 1);
});

test("fillComponentMedia drops its result when the message was edited or deleted while it was unfurling", async () => {
    updates.length = 0;
    events.length = 0;
    const fresh = () => ({ id: "3", channel_id: "2", toJSON: () => ({}), components: [{ type: 12, items: [{ media: { url: "https://media.test/a.png" } }] }] });
    stored.set("3", { id: "3", components: [{ type: 10, content: "edited meanwhile" }] });
    await embeds.fillComponentMedia(fresh());
    stored.delete("3");
    await embeds.fillComponentMedia(fresh());
    assert.equal(updates.length, 0);
    assert.equal(events.length, 0);
});

test("components media without a stored type still renders from its extension, and remote video uses the frame-capable proxy", () => {
    const [gallery] = media.proxyComponentsMedia([
        { type: 12, items: [{ media: { url: "https://media.test/a.JPG" } }, { media: { url: "https://media.test/b.mp4?x=1" } }, { media: { url: "https://media.test/c" } }] },
    ]);
    assert.equal(gallery.items[0].media.content_type, "image/jpeg");
    assert.match(gallery.items[0].media.proxy_url, /^https:\/\/cors\.estrogen\.delivery\//);
    assert.equal(gallery.items[1].media.content_type, "video/mp4");
    assert.equal(gallery.items[1].media.proxy_url, media.externalProxyUrl(new URL("https://media.test/b.mp4?x=1")));
    assert.equal(gallery.items[2].media.content_type, undefined);
});
