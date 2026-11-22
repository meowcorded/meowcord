import * as cheerio from "cheerio";
import probe from "probe-image-size";
import { Readable } from "node:stream";
import { fetchPublicUrl, isTrustedCdnAsset } from "@spacebar/util/util/networking/PublicNetwork";
import { FindOptionsWhere, In } from "typeorm";
import { EmbedCache, Message } from "@spacebar/database";
import { sleep, arrayDistinctBy, arrayGroupBy, normalizeUrl } from "@spacebar/extensions";
import {
    Config,
    emitEvent,
    corsProxyUrl,
    guessMediaType,
    isEmbedPlayerUrl,
    isLocalMediaUrl,
    MessageFlags,
    MessageUpdateEvent,
    OrmUtils,
    readVideoDimensions,
    videoFrameUrl,
} from "@spacebar/util";
import { BaseMessageComponents, Embed, EmbedImage, EmbedType, MessageComponentType, UnfurledMediaItem } from "@spacebar/schemas";

export function getDefaultFetchOptions(): RequestInit {
    return {
        redirect: "follow",
        headers: {
            "user-agent": Config.get().embeds.defaultUserAgent ?? "Mozilla/5.0 (compatible; Spacebar/1.0; +https://github.com/spacebarchat/server)",
            "accept-language": "en-US,en;q=0.9",
        },
        // size: 1024 * 1024 * 5, 	// grabbed from config later
        method: "GET",
    };
}

const fetchEmbedUrl = (url: string | URL, options: RequestInit = {}) => {
    if (!Config.get().externalRequests.thirdParty && !isTrustedCdnAsset(new URL(url), Config.get().cdn.endpointPublic ?? undefined))
        throw new Error("External embed requests are disabled");
    const configured = Config.get().limits.message.maxEmbedDownloadSize;
    const maxBytes = Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, 32 * 1024 * 1024) : 5 * 1024 * 1024;
    const target = new URL(url);
    const local = isTrustedCdnAsset(target, Config.get().cdn.endpointPublic ?? undefined);
    if (!local && isLocalMediaUrl(target.href)) throw new Error("Unsupported instance embed URL");
    return fetchPublicUrl(local ? target.href : corsProxyUrl(target), options, 0, {
        maxBytes,
        timeoutMs: 15000,
        trustedCdnOrigin: Config.get().cdn.endpointPublic ?? undefined,
        allowExternal: Config.get().externalRequests.thirdParty,
    });
};
const probeEmbedImage = async (url: string | URL) => {
    const response = await fetchEmbedUrl(url, getDefaultFetchOptions());
    if (!response.ok) throw new Error("Image probe request failed");
    return probe(Readable.from(Buffer.from(await response.arrayBuffer())));
};

const makeEmbedImage = (url: string | undefined, width: number | undefined, height: number | undefined): Required<Omit<EmbedImage, "content_type">> | undefined => {
    if (!url || !width || !height) return undefined;
    return {
        url,
        width,
        height,
        proxy_url: getProxyUrl(new URL(url), width, height),
    };
};

export const getProxyUrl = (url: URL, _width: number, _height: number): string => {
    if (isLocalMediaUrl(url.href)) return url.href;
    return corsProxyUrl(url);
};

const getMeta = ($: cheerio.CheerioAPI, name: string): string | undefined => {
    let elem = $(`meta[property="${name}"]`);
    if (!elem.length) elem = $(`meta[name="${name}"]`);
    const ret = elem.attr("content") || elem.text();
    return ret.trim().length == 0 ? undefined : ret;
};

const tryParseInt = (str: string | undefined) => {
    if (!str) return undefined;
    try {
        return parseInt(str);
    } catch (e) {
        return undefined;
    }
};

export const getMetaDescriptions = (text: string) => {
    const $ = cheerio.load(text);

    return {
        type: getMeta($, "og:type"),
        title: getMeta($, "og:title") || $("title").first().text(),
        provider_name: getMeta($, "og:site_name"),
        author: getMeta($, "article:author"),
        description: getMeta($, "og:description") || getMeta($, "description"),
        image: getMeta($, "og:image") || getMeta($, "twitter:image"),
        image_fallback: $(`image`).attr("src"),
        video_fallback: $(`video`).attr("src"),
        width: tryParseInt(getMeta($, "og:image:width")),
        height: tryParseInt(getMeta($, "og:image:height")),
        url: getMeta($, "og:url"),
        youtube_embed: getMeta($, "og:video:secure_url"),
        video: getMeta($, "og:video:secure_url") || getMeta($, "og:video:url") || getMeta($, "og:video"),
        video_type: getMeta($, "og:video:type"),
        video_width: tryParseInt(getMeta($, "og:video:width")),
        video_height: tryParseInt(getMeta($, "og:video:height")),
        refresh: $(`meta[http-equiv="refresh" i]`)
            .attr("content")
            ?.match(/url\s*=\s*['"]?([^'"\s]+)/i)?.[1],
        site_name: getMeta($, "og:site_name"),
        card: getMeta($, "twitter:card"),
        theme_color: getMeta($, "theme-color"),

        $,
    };
};

export const pageVideo = (page: URL, metas: Pick<ReturnType<typeof getMetaDescriptions>, "video" | "video_type" | "video_width" | "video_height">): EmbedImage | undefined => {
    if (!metas.video || !metas.video_width || !metas.video_height || !URL.canParse(metas.video, page)) return undefined;
    const video = new URL(metas.video, page);
    if (isEmbedPlayerUrl(video.href)) return { url: video.href, width: metas.video_width, height: metas.video_height };
    const contentType = metas.video_type?.startsWith("video/") ? metas.video_type : guessMediaType(video.href);
    if (!contentType?.startsWith("video/") || !/^https?:$/.test(video.protocol)) return undefined;
    return {
        url: video.href,
        proxy_url: getProxyUrl(video, metas.video_width, metas.video_height),
        width: metas.video_width,
        height: metas.video_height,
        content_type: contentType,
    };
};

const doFetch = async (url: URL, opts?: RequestInit) => {
    try {
        const res = await fetchEmbedUrl(url, OrmUtils.mergeDeep({ ...getDefaultFetchOptions() }, opts ?? {}));
        if (res.headers.get("content-length")) {
            const contentLength = parseInt(res.headers.get("content-length")!);
            if (Config.get().limits.message.maxEmbedDownloadSize && contentLength > Config.get().limits.message.maxEmbedDownloadSize) {
                return null;
            }
        }
        return res;
    } catch (e) {
        return null;
    }
};

const probeVideo = async (url: URL, contentLength: number) => {
    const chunk = 1024 * 1024;
    const read = async (range: string) => {
        const res = await fetchEmbedUrl(url, {
            ...getDefaultFetchOptions(),
            headers: { ...getDefaultFetchOptions().headers, range },
        }).catch(() => null);
        if (!res?.ok) return undefined;
        const reader = res.body?.getReader();
        if (!reader) return undefined;
        const parts: Buffer[] = [];
        const limit = res.status === 206 ? chunk : 16 * chunk;
        let total = 0;
        while (total < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(Buffer.from(value));
            total += value.length;
        }
        await reader.cancel().catch(() => {});
        return Buffer.concat(parts);
    };
    const head = await read(`bytes=0-${chunk - 1}`);
    const dims = head && readVideoDimensions(head);
    if (dims || contentLength <= chunk) return dims;
    const tail = await read(`bytes=-${chunk}`);
    return tail && readVideoDimensions(tail);
};

const genericVideoHandler = async (url: URL, head: Response): Promise<Embed | null> => {
    const dims = await probeVideo(url, Number(head.headers.get("content-length") ?? 0));
    if (!dims) return null;
    return {
        url: url.href,
        type: EmbedType.video,
        thumbnail: { url: url.href, proxy_url: videoFrameUrl(url), width: dims.width, height: dims.height, content_type: "image/jpeg" },
        video: {
            url: url.href,
            proxy_url: getProxyUrl(url, dims.width, dims.height),
            width: dims.width,
            height: dims.height,
            content_type: head.headers.get("content-type") ?? undefined,
        },
    };
};

const followMetaRefresh = async (url: URL, response: Response, load: (url: URL) => Promise<Response | null>) => {
    const text = await response.text();
    const target = getMetaDescriptions(text).refresh;
    if (!target || !URL.canParse(target, url)) return { url, text };
    const next = new URL(target, url);
    if (next.hostname !== url.hostname || next.href === url.href) return { url, text };
    const followed = await load(next);
    if (!followed?.ok || !followed.headers.get("content-type")?.includes("html")) return { url, text };
    return { url: next, text: await followed.text() };
};

const KLIPY_FETCH: RequestInit = {
    headers: { "user-agent": "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)" },
};

// klipy.com answers the public proxy with a Cloudflare challenge, so its pages are read from this server directly (the same
// way the /klipy/ media route already reaches its CDN). Only the page is read; the media still goes through the proxy.
const fetchKlipyPage = async (url: URL) => {
    if (!Config.get().externalRequests.thirdParty) return null;
    try {
        return await fetchPublicUrl(url.href, { ...getDefaultFetchOptions(), ...KLIPY_FETCH }, 0, { maxBytes: 2 * 1024 * 1024, timeoutMs: 10000, allowExternal: true });
    } catch {
        return null;
    }
};

const gifvHandler =
    (name: string, providerUrl: string, fetchOpts?: RequestInit, fetchPage?: (url: URL) => Promise<Response | null>) =>
    async (url: URL): Promise<Embed | null> => {
        const load = (target: URL) => (fetchPage ? fetchPage(target) : doFetch(target, fetchOpts));
        const response = await load(url);
        if (!response) return null;
        if (!response.headers.get("content-type")?.includes("html")) return genericImageHandler(url);
        const page = await followMetaRefresh(url, response, load);
        const metas = getMetaDescriptions(page.text);
        if (!metas.video || !metas.video_width || !metas.video_height) return genericImageHandler(url);
        const video = new URL(metas.video, page.url);
        return {
            url: url.href,
            type: EmbedType.gifv,
            provider: { name, url: providerUrl },
            thumbnail: makeEmbedImage(metas.image && new URL(metas.image, page.url).href, metas.width ?? metas.video_width, metas.height ?? metas.video_height),
            video: {
                url: video.href,
                proxy_url: getProxyUrl(video, metas.video_width, metas.video_height),
                width: metas.video_width,
                height: metas.video_height,
            },
        };
    };

const genericImageHandler = async (url: URL): Promise<Embed | null> => {
    const type = await fetchEmbedUrl(url, {
        ...getDefaultFetchOptions(),
        method: "HEAD",
    });

    let image;

    if (type.headers.get("content-type")?.startsWith("image/")) {
        const result = await probeEmbedImage(url.href);
        image = makeEmbedImage(url.href, result.width, result.height);
    } else if (type.headers.get("content-type")?.startsWith("video/")) {
        return genericVideoHandler(url, type);
    } else {
        // have to download the page, unfortunately
        const response = await doFetch(url);
        if (!response) return null;
        const metas = getMetaDescriptions(await response.text());
        image = makeEmbedImage(metas.image || metas.image_fallback, metas.width, metas.height);
    }

    if (!image) return null;

    return {
        url: url.href,
        type: EmbedType.image,
        thumbnail: image,
    };
};

// The watch page is fetched through a public proxy, and from there YouTube answers with its generic home page. The oEmbed
// endpoint answers with JSON whatever the caller's address, so videos are built from that.
const youtubeVideoId = (url: URL) => {
    const host = url.hostname.replace(/^(?:www|m|music)\./, "");
    let id: string | null | undefined = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    else if (host === "youtube.com") id = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
};

const youtubeVideoEmbed = async (url: URL): Promise<Embed | null> => {
    const id = youtubeVideoId(url);
    if (!id) return null;
    try {
        const response = await fetchEmbedUrl(
            `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
            getDefaultFetchOptions(),
        );
        if (!response.ok) return null;
        const info = (await response.json()) as { title?: string; author_name?: string; author_url?: string; thumbnail_url?: string };
        if (!info.title) return null;
        // the full-size thumbnail doesn't exist for every video; the one in the oEmbed answer always does
        const full = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
        const hasFull = await fetchEmbedUrl(full, { ...getDefaultFetchOptions(), method: "HEAD" })
            .then((head) => head.ok)
            .catch(() => false);
        return {
            url: url.href,
            type: EmbedType.video,
            title: info.title,
            provider: { name: "YouTube", url: "https://www.youtube.com" },
            author: info.author_name ? { name: info.author_name, url: info.author_url } : undefined,
            color: 16711680,
            thumbnail: hasFull ? makeEmbedImage(full, 1280, 720) : makeEmbedImage(info.thumbnail_url, 480, 360),
            video: { url: `https://www.youtube.com/embed/${id}`, width: 1280, height: 720 },
        };
    } catch {
        return null;
    }
};

type FxTwitterMedia = { type: string; url: string; thumbnail_url?: string; width: number; height: number; variants?: { url: string; bitrate?: number; content_type: string }[] };
type FxTwitterStatus = {
    url: string;
    text: string;
    created_timestamp: number;
    likes: number;
    retweets: number;
    replies: number;
    author: { name: string; screen_name: string; url: string; avatar_url?: string };
    media?: { all?: FxTwitterMedia[] };
};

export const fxTwitterStatusEmbed = (tweet: FxTwitterStatus): Embed => {
    const media = tweet.media?.all ?? [];
    const photo = media.find((item) => item.type === "photo");
    const clip = media.find((item) => item.type === "video" || item.type === "gif");
    const playable = clip?.variants
        ?.filter((variant) => variant.content_type === "video/mp4")
        .toSorted((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        .find((variant, index, all) => (variant.bitrate ?? 0) <= 2500000 || index === all.length - 1);
    const video = clip && URL.canParse(playable?.url ?? clip.url) ? { ...clip, target: new URL(playable?.url ?? clip.url) } : undefined;
    return {
        type: EmbedType.rich,
        url: tweet.url,
        description: tweet.text,
        color: 1942002,
        timestamp: new Date(tweet.created_timestamp * 1000),
        author: {
            name: `${tweet.author.name} (@${tweet.author.screen_name})`,
            url: tweet.author.url,
            icon_url: tweet.author.avatar_url,
        },
        fields: [
            { inline: true, name: "Replies", value: String(tweet.replies) },
            { inline: true, name: "Reposts", value: String(tweet.retweets) },
            { inline: true, name: "Likes", value: String(tweet.likes) },
        ],
        footer: { text: "X", icon_url: "https://abs.twimg.com/icons/apple-touch-icon-192x192.png" },
        image: !video && photo ? makeEmbedImage(photo.url, photo.width, photo.height) : undefined,
        thumbnail: video?.thumbnail_url ? makeEmbedImage(video.thumbnail_url, video.width, video.height) : undefined,
        video: video && {
            url: video.target.href,
            proxy_url: getProxyUrl(video.target, video.width, video.height),
            width: video.width,
            height: video.height,
            content_type: "video/mp4",
        },
    };
};

const fxTwitterEmbed = async (url: URL): Promise<Embed | null> => {
    const id = url.pathname.match(/^\/[^/]+\/status(?:es)?\/(\d+)/)?.[1];
    if (!id) return null;
    const response = await fetchEmbedUrl(`https://api.fxtwitter.com/status/${id}`, getDefaultFetchOptions());
    if (!response.ok) return null;
    const { tweet } = (await response.json()) as { tweet?: FxTwitterStatus };
    return tweet ? fxTwitterStatusEmbed(tweet) : null;
};

export const EmbedHandlers: {
    [key: string]: (url: URL) => Promise<Embed | Embed[] | null>;
} = {
    // the url does not have a special handler
    default: async (url: URL) => {
        const type = await fetchEmbedUrl(url, {
            ...getDefaultFetchOptions(),
            method: "HEAD",
        });
        if (type.headers.get("content-type")?.startsWith("image/")) return await genericImageHandler(url);
        if (type.headers.get("content-type")?.startsWith("video/")) return await genericVideoHandler(url, type);

        const response = await doFetch(url);
        if (!response) return null;

        const text = await response.text();
        const metas = getMetaDescriptions(text);

        if (!metas.image) metas.image = metas.image_fallback;
        if (metas.image) metas.image = URL.canParse(metas.image, url) ? new URL(metas.image, url).href : undefined;

        if (metas.image && (!metas.width || !metas.height)) {
            const result = await probeEmbedImage(metas.image);
            metas.width = result.width;
            metas.height = result.height;
        }

        if (!metas.image && (!metas.title || !metas.description)) {
            // we don't have any content to display
            return null;
        }

        let embedType = EmbedType.link;
        if (metas.type == "article") embedType = EmbedType.article;
        if (metas.type == "object") embedType = EmbedType.article; // github
        if (metas.type == "rich") embedType = EmbedType.rich;

        const image = makeEmbedImage(metas.image, metas.width, metas.height);
        const color = /^#[0-9a-f]{6}$/i.test(metas.theme_color ?? "") ? parseInt(metas.theme_color!.slice(1), 16) : undefined;
        const video = image && pageVideo(url, metas);
        return {
            url: url.href,
            type: video ? EmbedType.video : embedType,
            title: metas.title,
            ...(video ? { thumbnail: image, video } : metas.card === "summary_large_image" ? { image } : { thumbnail: image }),
            color,
            description: metas.description,
            provider: metas.site_name
                ? {
                      name: metas.site_name,
                      url: url.origin,
                  }
                : undefined,
        };
    },

    "giphy.com": gifvHandler("GIPHY", "https://giphy.com/"),
    "media4.giphy.com": genericImageHandler,
    "tenor.com": gifvHandler("Tenor", "https://tenor.co"),
    "c.tenor.com": genericImageHandler,
    "media.tenor.com": genericImageHandler,
    "media1.tenor.com": genericImageHandler,

    "klipy.com": gifvHandler("KLIPY", "https://klipy.com/", KLIPY_FETCH, fetchKlipyPage),
    "www.klipy.com": gifvHandler("KLIPY", "https://klipy.com/", KLIPY_FETCH, fetchKlipyPage),
    "static.klipy.com": genericImageHandler,
    "static2.klipy.com": genericImageHandler,

    "facebook.com": (url) => EmbedHandlers["www.facebook.com"](url),
    "www.facebook.com": async (url: URL) => {
        const response = await doFetch(url);
        if (!response) return null;
        const metas = getMetaDescriptions(await response.text());

        return {
            url: url.href,
            type: EmbedType.link,
            title: metas.title,
            description: metas.description,
            thumbnail: makeEmbedImage(metas.image, 640, 640),
            color: 16777215,
        };
    },

    "x.com": (url) => EmbedHandlers["www.twitter.com"](url),
    "www.x.com": (url) => EmbedHandlers["www.twitter.com"](url),
    "mobile.x.com": (url) => EmbedHandlers["www.twitter.com"](url),
    "mobile.twitter.com": (url) => EmbedHandlers["www.twitter.com"](url),
    "twitter.com": (url) => EmbedHandlers["www.twitter.com"](url),
    "www.twitter.com": async (url: URL) => {
        if (!Config.get().externalRequests.thirdParty) return null;
        const token = Config.get().external.twitter;
        if (!token) return fxTwitterEmbed(url);

        if (!url.href.includes("/status/")) return null; // TODO;
        const id = url.pathname.split("/")[3]; // super bad lol
        if (!parseInt(id)) return null;
        const endpointUrl =
            `https://api.twitter.com/2/tweets/${id}` +
            `?expansions=author_id,attachments.media_keys` +
            `&media.fields=url,width,height` +
            `&tweet.fields=created_at,public_metrics` +
            `&user.fields=profile_image_url`;

        const response = await fetchEmbedUrl(endpointUrl, {
            ...getDefaultFetchOptions(),
            headers: {
                authorization: `Bearer ${token}`,
            },
        });
        const json = (await response.json()) as {
            errors?: never[];
            includes: {
                users: {
                    profile_image_url: string;
                    username: string;
                    name: string;
                }[];
                media: {
                    type: string;
                    width: number;
                    height: number;
                    url: string;
                }[];
            };
            data: {
                text: string;
                created_at: string;
                public_metrics: { like_count: number; retweet_count: number };
            };
        };
        if (json.errors) return null;
        const author = json.includes.users[0];
        const text = json.data.text;
        const created_at = new Date(json.data.created_at);
        const metrics = json.data.public_metrics;
        const media = json.includes.media?.filter((x: { type: string }) => x.type == "photo");

        const embed: Embed = {
            type: EmbedType.rich,
            url: `${url.origin}${url.pathname}`,
            description: text,
            author: {
                url: `https://twitter.com/${author.username}`,
                name: `${author.name} (@${author.username})`,
                proxy_icon_url: getProxyUrl(new URL(author.profile_image_url), 400, 400),
                icon_url: author.profile_image_url,
            },
            timestamp: created_at,
            fields: [
                {
                    inline: true,
                    name: "Likes",
                    value: metrics.like_count.toString(),
                },
                {
                    inline: true,
                    name: "Retweet",
                    value: metrics.retweet_count.toString(),
                },
            ],
            color: 1942002,
            footer: {
                text: "Twitter",
                proxy_icon_url: getProxyUrl(new URL("https://abs.twimg.com/icons/apple-touch-icon-192x192.png"), 192, 192),
                icon_url: "https://abs.twimg.com/icons/apple-touch-icon-192x192.png",
            },
            // Discord doesn't send this?
            // provider: {
            // 	name: "Twitter",
            // 	url: "https://twitter.com"
            // },
        };

        if (media && media.length > 0) {
            embed.image = {
                width: media[0].width,
                height: media[0].height,
                url: media[0].url,
                proxy_url: getProxyUrl(new URL(media[0].url), media[0].width, media[0].height),
            };
            media.shift();
        }

        return embed;

        // TODO: Client won't merge these into a single embed, for some reason.
        // return [embed, ...media.map((x: any) => ({
        // 	// generate new embeds for each additional attachment
        // 	type: EmbedType.rich,
        // 	url: url.href,
        // 	image: {
        // 		width: x.width,
        // 		height: x.height,
        // 		url: x.url,
        // 		proxy_url: getProxyUrl(new URL(x.url), x.width, x.height)
        // 	}
        // }))];
    },

    "open.spotify.com": async (url: URL) => {
        const response = await doFetch(url);
        if (!response) return null;
        const metas = getMetaDescriptions(await response.text());

        return {
            url: url.href,
            type: EmbedType.link,
            title: metas.title,
            description: metas.description,
            thumbnail: makeEmbedImage(metas.image, 640, 640),
            provider: {
                url: "https://spotify.com",
                name: "Spotify",
            },
        };
    },

    // TODO: docs: Pixiv won't work without Imagor
    "pixiv.net": (url) => EmbedHandlers["www.pixiv.net"](url),
    "www.pixiv.net": async (url: URL) => {
        const response = await doFetch(url);
        if (!response) return null;
        const metas = getMetaDescriptions(await response.text());

        if (!metas.image) return null;

        return {
            url: url.href,
            type: EmbedType.image,
            title: metas.title,
            description: metas.description,
            image: makeEmbedImage(metas.image || metas.image_fallback, metas.width, metas.height),
            provider: {
                url: "https://pixiv.net",
                name: "Pixiv",
            },
        };
    },

    "store.steampowered.com": async (url: URL) => {
        const response = await doFetch(url);
        if (!response) return null;
        const metas = getMetaDescriptions(await response.text());
        const numReviews = metas.$("#review_summary_num_reviews").val() as string | undefined;
        const price = metas.$(".game_purchase_price.price").data("price-final") as number | undefined;
        const releaseDate = metas.$(".release_date").find("div.date").text().trim();
        const isReleased = new Date(releaseDate) < new Date();

        const fields: Embed["fields"] = [];

        if (numReviews)
            fields.push({
                name: "Reviews",
                value: numReviews,
                inline: true,
            });

        if (price)
            fields.push({
                name: "Price",
                value: `$${price / 100}`,
                inline: true,
            });

        // if the release date is in the past, it's already out
        if (releaseDate && !isReleased)
            fields.push({
                name: "Release Date",
                value: releaseDate,
                inline: true,
            });

        return {
            url: url.href,
            type: EmbedType.rich,
            title: metas.title,
            description: metas.description,
            image: {
                // TODO: meant to be thumbnail.
                // isn't this standard across all of steam?
                width: 460,
                height: 215,
                url: metas.image,
                proxy_url: metas.image ? getProxyUrl(new URL(metas.image), 460, 215) : undefined,
            },
            provider: {
                url: "https://store.steampowered.com",
                name: "Steam",
            },
            fields,
            // TODO: Video
        };
    },

    "reddit.com": (url) => EmbedHandlers["www.reddit.com"](url),
    "www.reddit.com": async (url: URL) => {
        const res = await EmbedHandlers["default"](url);
        return {
            ...res,
            color: 16777215,
            provider: {
                name: "reddit",
            },
        };
    },

    "youtu.be": (url) => EmbedHandlers["www.youtube.com"](url),
    "youtube.com": (url) => EmbedHandlers["www.youtube.com"](url),
    "music.youtube.com": (url) => EmbedHandlers["www.youtube.com"](url),
    "www.youtube.com": async (url: URL): Promise<Embed | null> => {
        const video = await youtubeVideoEmbed(url);
        if (video) return video;
        const response = await doFetch(url, {
            headers: {
                cookie: Config.get().embeds.youtube.cookie ?? "CONSENT=PENDING+999; hl=en",
                // TODO: dynamically obtain current system curl's user agent, ie. via https://ifconfig.me/ua
                ...(Config.get().embeds.youtube.useCurlUserAgent ? { "user-agent": "curl/8.18.0" } : {}),
                ...(Config.get().embeds.youtube.userAgent != null
                    ? {
                          "user-agent": Config.get().embeds.youtube.userAgent ?? undefined /* type check fails for some reason otherwise */,
                      }
                    : {}),
            },
        });
        if (!response) return null;
        const metas = getMetaDescriptions(await response.text());

        return {
            video: makeEmbedImage(metas.youtube_embed, metas.width, metas.height),
            url: url.href,
            type: metas.youtube_embed ? EmbedType.video : EmbedType.link,
            title: metas.title,
            thumbnail: makeEmbedImage(metas.image || metas.image_fallback, metas.width, metas.height),
            provider: {
                url: "https://www.youtube.com",
                name: "YouTube",
            },
            description: metas.description,
            color: 16711680,
            author: metas.author
                ? {
                      name: metas.author,
                      // TODO: author channel url
                  }
                : undefined,
        };
    },

    "www.xkcd.com": (url) => EmbedHandlers["xkcd.com"](url),
    "xkcd.com": async (url) => {
        const response = await doFetch(url);
        if (!response) return null;

        const metas = getMetaDescriptions(await response.text());
        const hoverText = metas.$("#comic img").attr("title");

        if (!metas.image) return null;

        const { width, height } = await probeEmbedImage(metas.image);

        return {
            url: url.href,
            type: EmbedType.rich,
            title: `xkcd: ${metas.title}`,
            image: makeEmbedImage(metas.image, width, height),
            footer: hoverText
                ? {
                      text: hoverText,
                  }
                : undefined,
        };
    },

    // the url is an image from this instance
    self: async (url: URL): Promise<Embed | null> => {
        const result = await probeEmbedImage(url.href);

        return {
            url: url.href,
            type: EmbedType.image,
            thumbnail: {
                width: result.width,
                height: result.height,
                url: url.href,
                proxy_url: url.href,
            },
        };
    },
};

const LINK_REGEX = /<?https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)>?/g;

export function getMessageContentUrls(message: Message) {
    const content = message.content?.replace(/ *`[^)]*` */g, ""); // remove markdown

    return content?.match(LINK_REGEX) ?? [];
}

export async function dropDuplicateCacheEntries(entries: EmbedCache[]): Promise<EmbedCache[]> {
    const grouped = Array.from(arrayGroupBy(entries, (e) => e.url).values()).map((g) =>
        g.toSorted((e1, e2) => {
            let diff = e2.createdAt.getTime() - e1.createdAt.getTime();
            if (diff == 0) diff = Number(BigInt(e2.id) - BigInt(e1.id));
            return diff;
        }),
    );

    const fullToDeleteIds: string[] = [];
    for (const group of grouped) {
        if (group.length <= 1) continue;
        // console.log("[EmbedCache] Removing all but first from cache:", group);
        // this might be backwards, sort always confuses me lol
        const toDelete = group.slice(1);
        const toDeleteIds = toDelete.map((x) => x.id);
        fullToDeleteIds.push(...toDeleteIds);
        console.warn("[EmbedCache] Removing duplicate IDs for", toDelete[0].url, " - ", toDeleteIds);
    }

    await EmbedCache.delete({ id: In(fullToDeleteIds) } as FindOptionsWhere<EmbedCache>);

    // console.log("[EmbedCache] Cached embeds:", Array.from(grouped.map((x) => x[0].url)));
    return await Promise.all(
        Array.from(grouped.map((x) => x[0])).map(async (e) => {
            if (e.embed != undefined && e.embeds == undefined) {
                console.warn("[EmbedCache] Converting old embed to new embeds array for url", e.url);
                e.embeds = [e.embed];
                e.embed = undefined;
                return await e.save();
            }
            return e;
        }),
    );
}

// hack to make nodejs not die
function getSlowdownFactor(off: number) {
    if (off < 10) return off;
    if (off < 25) return 100 + off * 2;
    if (off < 50) return 200 + off * 10;
    if (off < 100) return 500 + off * 15;
    if (off < 250) return 750 + off * 20;
    return 1000 + off * 150;
}

const pendingEmbeds = new Map<string, Promise<EmbedCache | null>>();

export async function getOrUpdateEmbedCache(urls: string[], cb?: (url: string, embeds: Embed[]) => Promise<void>): Promise<EmbedCache[]> {
    urls = arrayDistinctBy(urls, (x) => x);
    const embeds: EmbedCache[] = [];

    const cachedEmbeds = await dropDuplicateCacheEntries(
        await EmbedCache.find({
            where: {
                url: In(urls.map(normalizeUrl)),
            },
        }),
    );
    embeds.push(...cachedEmbeds);
    for (const cached of cachedEmbeds)
        await cb?.(
            urls.find((url) => normalizeUrl(url) === cached.url) ?? cached.url,
            (cached.embeds ?? []).filter((e) => e !== undefined),
        );

    const urlsToGenerate = urls.filter((url) => !cachedEmbeds.some((e) => e.url == normalizeUrl(url)));

    if (urlsToGenerate.length > 0) console.log("[Embeds] Need to generate embeds for urls:", urlsToGenerate);
    if (cachedEmbeds.length > 0)
        console.log(
            "[Embeds] Already had embeds for urls:",
            cachedEmbeds.map((e) => e.url),
        );

    let off = 0;
    const generatedEmbeds = await Promise.all(
        urlsToGenerate.map(async (link) => {
            const key = normalizeUrl(link);
            let pending = pendingEmbeds.get(key);

            if (!pending) {
                await sleep(getSlowdownFactor(off++)); // ...or nodejs gets overwhelmed and times out
                pending = pendingEmbeds.get(key);
                if (!pending) {
                    pending = generateEmbedSingle(link).finally(() => pendingEmbeds.delete(key));
                    pendingEmbeds.set(key, pending);
                }
            }

            const result = await pending;
            if (result) await cb?.(link, result.embeds ?? []);

            return result;
        }),
    );

    embeds.push(...generatedEmbeds.filter((e) => e != null));

    return embeds;
}

async function generateEmbedSingle(link: string, cb?: (url: string, embeds: Embed[]) => Promise<void>): Promise<EmbedCache | null> {
    if (!URL.canParse(link)) return null;
    const url = new URL(link);
    const isLocal = url.origin === new URL(Config.get().cdn.endpointPublic!).origin;
    if (isLocal && !isTrustedCdnAsset(url, Config.get().cdn.endpointPublic ?? undefined)) return null;
    if (!isLocal && !Config.get().externalRequests.thirdParty) return null;
    const handler = isLocal ? EmbedHandlers["self"] : (EmbedHandlers[url.hostname] ?? EmbedHandlers["default"]);
    try {
        let res = await handler(url);
        if (!res) return null;
        if (!Array.isArray(res)) res = [res];

        // Cache with normalized URL
        const cache = await EmbedCache.create({
            url: normalizeUrl(url.href),
            embeds: res,
            createdAt: new Date(),
        }).save();

        console.log("[Embeds] Generated embed for", link);
        await cb?.(link, res);
        return cache;
    } catch (e) {
        console.error(`[Embeds] Error while generating embed for ${link}`, e);
    }
    return null;
}

const UnfurledMediaLoadingState = { LOADED_SUCCESS: 2, LOADED_NOT_FOUND: 3 } as const;

export async function unfurlComponentMedia(media: UnfurledMediaItem) {
    try {
        const url = new URL(media.url);
        const head = await fetchEmbedUrl(url, { ...getDefaultFetchOptions(), method: "HEAD" });
        const contentType = head.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if ([400, 401, 403, 404, 410, 451].includes(head.status)) {
            media.loading_state = UnfurledMediaLoadingState.LOADED_NOT_FOUND;
            return media;
        }
        if (!head.ok || !contentType) throw new Error("Component media answered without a usable type");
        const size = contentType.startsWith("image/")
            ? await probeEmbedImage(url).catch(() => undefined)
            : contentType.startsWith("video/")
              ? await probeVideo(url, Number(head.headers.get("content-length") ?? 0))
              : undefined;
        Object.assign(media, { content_type: contentType, ...(size && { width: size.width, height: size.height }) });
    } catch {
        media.content_type ??= guessMediaType(media.url);
    }
    media.loading_state = media.content_type ? UnfurledMediaLoadingState.LOADED_SUCCESS : UnfurledMediaLoadingState.LOADED_NOT_FOUND;
    return media;
}

export async function fillComponentMedia(message: Message) {
    const collect = (components: BaseMessageComponents[]): UnfurledMediaItem[] =>
        components.flatMap((component) => {
            if (component.type === MessageComponentType.Container) return collect(component.components);
            if (component.type === MessageComponentType.Section && component.accessory.type === MessageComponentType.Thumbnail) return [component.accessory.media];
            if (component.type === MessageComponentType.MediaGallery) return component.items.map((item) => item.media);
            return [];
        });
    const pending = collect(message.components ?? []).filter(
        (media) =>
            !media.content_type && media.loading_state === undefined && URL.canParse(media.url) && /^https?:$/.test(new URL(media.url).protocol) && !isLocalMediaUrl(media.url),
    );
    if (!pending.length) return message;
    const canonical = (value: unknown): string =>
        Array.isArray(value)
            ? `[${value.map(canonical).join(",")}]`
            : value && typeof value === "object"
              ? `{${Object.entries(value)
                    .filter(([, entry]) => entry !== undefined)
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
                    .join(",")}}`
              : JSON.stringify(value);
    const sent = canonical(message.components);
    const queue = pending.values();
    await Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
            for (const media of queue) await unfurlComponentMedia(media);
        }),
    );
    const stored = await Message.findOne({ where: { id: message.id, channel_id: message.channel_id }, select: { id: true, components: true } });
    if (!stored || canonical(stored.components) !== sent) return message;
    await Message.update({ id: message.id, channel_id: message.channel_id }, { components: message.components as never });
    await emitEvent({
        event: "MESSAGE_UPDATE",
        channel_id: message.channel_id,
        data: message.toJSON(),
    } satisfies MessageUpdateEvent);
    return message;
}

export async function fillMessageUrlEmbeds(message: Message) {
    const linkMatches = getMessageContentUrls(message).filter((l) => !l.startsWith("<") && !l.endsWith(">"));

    // Filter out embeds that could be links, start from scratch
    message.embeds = message.embeds.filter((embed) => embed.type === "rich");

    // Dont add embeds if the message has embeds suppressed
    if ((message.flags & Number(MessageFlags.FLAGS.SUPPRESS_EMBEDS)) !== 0) return message;

    if (linkMatches.length == 0) return message;

    const uniqueLinks: string[] = arrayDistinctBy(linkMatches, normalizeUrl);

    if (uniqueLinks.length === 0) {
        // No valid unique links found, update message to remove old embeds
        message.embeds = message.embeds.filter((embed) => embed.type === "rich");
        await saveAndEmitMessageUpdate(message);
        return message;
    }

    const rich = message.embeds;
    const order = uniqueLinks.map(normalizeUrl);
    const found = new Map<string, Embed[]>();

    // avoid a race condition updating the same row
    let messageUpdateLock = saveAndEmitMessageUpdate(message);
    await getOrUpdateEmbedCache(uniqueLinks, async (url, embeds) => {
        found.set(normalizeUrl(url), embeds);
        message.embeds = [...rich, ...order.flatMap((key) => found.get(key) ?? [])].slice(0, Config.get().limits.message.maxEmbeds);

        try {
            await messageUpdateLock;
        } catch {
            /* empty */
        }
        messageUpdateLock = saveAndEmitMessageUpdate(message);
    });

    await saveAndEmitMessageUpdate(message);
    return message;
}

async function saveAndEmitMessageUpdate(message: Message) {
    // console.warn("Emitting message update for", message.id, "with embeds", message.embeds);
    await Message.update({ id: message.id, channel_id: message.channel_id }, { embeds: message.embeds });
    await emitEvent({
        event: "MESSAGE_UPDATE",
        channel_id: message.channel_id,
        data: message.toJSON(),
    } satisfies MessageUpdateEvent);
}
