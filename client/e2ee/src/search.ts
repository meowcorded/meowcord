import type { RawMessage } from "./engine";

export interface SearchQuery {
    content?: string;
    author_id?: string | string[];
    has?: string | string[];
    offset?: number | string;
    limit?: number | string;
    sort_order?: string;
}

const values = (value: unknown): string[] => (value == null ? [] : (Array.isArray(value) ? value : [value]).map(String));

export function readSearchQuery(params: URLSearchParams): SearchQuery {
    const list = (key: string) =>
        [...params].filter(([name]) => name === key || (name.startsWith(`${key}[`) && /^\[\d*\]$/.test(name.slice(key.length)))).map(([, value]) => value);
    return {
        content: params.get("content") ?? undefined,
        author_id: list("author_id"),
        has: list("has"),
        offset: params.get("offset") ?? undefined,
        limit: params.get("limit") ?? undefined,
        sort_order: params.get("sort_order") ?? undefined,
    };
}

export function matchesSearch(message: RawMessage, query: SearchQuery): boolean {
    const text = String(message.content ?? "").toLowerCase();
    const words = String(query.content ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    const authors = values(query.author_id);
    if (!words.every((word) => text.includes(word)) || (authors.length && !authors.includes(String(message.author?.id)))) return false;
    const embeds = (message.embeds ?? []) as { type?: string; image?: unknown; video?: unknown }[];
    const media = (prefix: string) =>
        message.attachments?.some((attachment) =>
            String(attachment.content_type ?? "")
                .toLowerCase()
                .startsWith(prefix),
        ) ?? false;
    const has: Record<string, boolean> = {
        link: /https?:\/\//i.test(text),
        embed: embeds.length > 0,
        file: !!message.attachments?.length,
        image: media("image/") || embeds.some((embed) => embed.type === "image" || embed.type === "gifv" || !!embed.image),
        video: media("video/") || embeds.some((embed) => embed.type === "video" || !!embed.video),
        sound: media("audio/"),
        sticker: !!message.sticker_items?.length,
    };
    const filters = values(query.has);
    const wanted = filters.filter((filter) => !filter.startsWith("-"));
    return (!wanted.length || wanted.some((filter) => has[filter] === true)) && filters.filter((filter) => filter.startsWith("-")).every((filter) => !has[filter.slice(1)]);
}
