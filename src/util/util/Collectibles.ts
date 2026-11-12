import fs from "node:fs/promises";
import path from "node:path";
import { ASSETS_FOLDER } from "./Constants";
import { Config } from "./Config";
import { instanceName } from "./Branding";
import { ProcessLifecycle } from "./ProcessLifecycle";
import { steamFrameCategory, steamFrameRecency } from "./SteamFrames";

export enum CollectibleItemType {
    AVATAR_DECORATION = 0,
    PROFILE_EFFECT = 1,
    NAMEPLATE = 2,
    PROFILE_FRAME = 3,
    BUNDLE = 1000,
    VARIANTS_GROUP = 2000,
    EXTERNAL_SKU = 3000,
}

export interface CollectibleItem {
    type: CollectibleItemType;
    sku_id: string;
    id?: string;
    asset?: string;
    label?: string;
    palette?: string;
    [key: string]: unknown;
}

export interface CollectibleProduct {
    sku_id: string;
    name: string;
    type: CollectibleItemType;
    items: CollectibleItem[];
    category_sku_id?: string;
    bundled_products?: CollectibleProduct[];
    variants?: CollectibleProduct[];
    [key: string]: unknown;
}

export interface CollectibleCategory {
    sku_id: string;
    name: string;
    summary?: string;
    store_listing_id?: string;
    hero_ranking?: string[];
    products: CollectibleProduct[];
    [key: string]: unknown;
}

interface CollectiblePrices {
    [group: string]: {
        country_prices: {
            country_code: string;
            prices: { amount: number; currency: string; exponent: number }[];
        };
    };
}

// builtin keeps every pack of the mirrored catalog, including the ones taken out of the shop
type Catalog = {
    categories: CollectibleCategory[];
    products: Map<string, CollectibleProduct>;
    items: Map<string, CollectibleItem>;
    builtin?: CollectibleCategory[];
};

const SOURCES = {
    catalog: {
        url: process.env.COLLECTIBLES_CATALOG_URL,
        file: path.join(ASSETS_FOLDER, "collectibles.json"),
    },
    effects: {
        url: process.env.PROFILE_EFFECTS_CATALOG_URL,
        file: path.join(ASSETS_FOLDER, "profile-effects.json"),
    },
};
type Source = (typeof SOURCES)[keyof typeof SOURCES];
const EXTERNAL_REFRESH = process.env.COLLECTIBLES_EXTERNAL_REFRESH === "true";
const refreshHours = Number(process.env.COLLECTIBLES_REFRESH_HOURS || 12);
const REFRESH_MS = (Number.isFinite(refreshHours) && refreshHours > 0 ? Math.max(refreshHours, 1 / 60) : 12) * 3_600_000;
const DOWNLOAD_TIMEOUT_MS = 5000;

let catalog: Promise<Catalog> | undefined;
let catalogGeneration = 0;
let refreshTimer: NodeJS.Timeout | undefined;
let stopping = false;

// the admin panel's own packs, and the mirrored packs it took out of the shop. The api registers this, since the
// database isn't reachable from here
export type BuiltinCollectibleOverride = {
    name?: string;
    summary?: string;
    position?: number;
    banner_url?: string;
    logo_url?: string;
};
export type CustomCollectibles = {
    categories: CollectibleCategory[];
    hidden: string[];
    overrides?: Record<string, BuiltinCollectibleOverride>;
};
let customSource: (() => Promise<CustomCollectibles>) | undefined;

const withCustom = async (base: Catalog): Promise<Catalog> => {
    const custom = await customSource?.().catch((e) => {
        console.error("[Collectibles] could not load the custom packs", e);
        return undefined;
    });
    if (!custom) return { ...base, builtin: base.categories };
    const products = new Map(base.products);
    const items = new Map(base.items);
    for (const category of custom.categories)
        for (const product of category.products) {
            products.set(product.sku_id, product);
            for (const item of product.items) items.set(item.sku_id, item);
        }
    // hidden packs only leave the shop, so people who already have their items can keep using them
    const hidden = new Set(custom.hidden);
    const builtin = base.categories
        .map((category, index) => {
            const override = custom.overrides?.[category.sku_id];
            const result: CollectibleCategory & { position: number; customized: boolean } = {
                ...category,
                position: override?.position ?? index,
                customized: !!override && Object.keys(override).length > 0,
            };
            if (override?.name !== undefined) {
                result.name = override.name;
                result.hero_block_title = override.name;
            }
            if (override?.summary !== undefined) result.summary = override.summary;
            if (override?.banner_url !== undefined) {
                for (const field of ["hero_banner_url", "catalog_banner_url", "featured_block_url", "mobile_banner_url", "mobile_hero_url"]) result[field] = override.banner_url;
                result.hero_banner_animated_url = null;
            }
            if (override?.logo_url !== undefined) {
                result.logo_url = override.logo_url;
                result.hero_logo_url = override.logo_url;
            }
            return result;
        })
        .sort((a, b) => a.position - b.position);
    return {
        categories: [...custom.categories, ...builtin.filter((x) => !hidden.has(x.sku_id))],
        products,
        items,
        builtin,
    };
};

const localize = (raw: string) => {
    const branded = raw.replace(/\bDiscord\b/g, JSON.stringify(instanceName()).slice(1, -1));
    const cdn = Config.get().cdn.endpointPublic?.replace(/\/+$/, "");
    if (!cdn) return branded;
    return branded.replaceAll("https://cdn.discordapp.com/assets/content/", `${cdn}/content-assets/`).replaceAll("https://cdn.discordapp.com/media/v1/", `${cdn}/media/v1/`);
};

const parse = (raw: string, effectsRaw?: string): Catalog => {
    const steam = steamFrameCategory() as unknown as CollectibleCategory;
    const categories = [
        ...(JSON.parse(localize(raw)) as CollectibleCategory[]).sort((a, b) => (BigInt(b.sku_id) > BigInt(a.sku_id) ? 1 : -1)),
        ...(steam.products.length ? [steam] : []),
    ];
    const effects = new Map((effectsRaw ? (JSON.parse(localize(effectsRaw)) as CollectibleItem[]) : []).map((x) => [x.sku_id, x]));
    const products = new Map<string, CollectibleProduct>();
    const items = new Map<string, CollectibleItem>();

    const index = (product: CollectibleProduct) => {
        product.items = product.items?.map((item) => (item.type === CollectibleItemType.PROFILE_EFFECT && !item.effects ? { ...effects.get(item.sku_id), ...item } : item));
        product.prices = Object.fromEntries(
            Object.entries((product.prices ?? {}) as CollectiblePrices).map(([group, { country_prices }]) => [
                group,
                {
                    country_prices: {
                        ...country_prices,
                        prices: country_prices.prices.map((price) => ({ ...price, amount: 0 })),
                    },
                },
            ]),
        );
        product.unpublished_at = null;
        // the client keys its product list by listing id, so products without one (most of the mirror) collapse into one
        product.store_listing_id ??= product.sku_id;
        product.premium_type = 2;
        product.hide_badge = true;
        // the same product shows up in several places, some with its items left out (inside bundles, for one); keep a
        // copy that has them. Frames have no asset or effects, so a copy with layers counts too
        const known = products.get(product.sku_id);
        const detailed = (x: CollectibleProduct) => (x.items ?? []).some((item) => item.asset || item.effects || item.layers);
        if (!known || (detailed(product) && !detailed(known)) || (product.items?.length ?? 0) > (known.items?.length ?? 0)) products.set(product.sku_id, product);
        for (const item of product.items ?? []) {
            const known = items.get(item.sku_id);
            if (!known || Object.keys(item).length > Object.keys(known).length) items.set(item.sku_id, item);
        }
        product.bundled_products?.forEach(index);
        product.variants?.forEach(index);
    };
    for (const category of categories) {
        category.unpublished_at = null;
        category.products.forEach(index);
    }

    const hydrated = new Set<CollectibleProduct>();
    const usable = (product: CollectibleProduct): boolean => {
        if (!hydrated.has(product)) {
            hydrated.add(product);
            product.items = (product.items ?? []).map((item) => items.get(item.sku_id) ?? item);
        }
        return (
            product.items.every((item) => item.type !== CollectibleItemType.PROFILE_EFFECT || Array.isArray(item.effects)) &&
            (product.bundled_products ?? []).every(usable) &&
            (product.variants ?? []).every(usable)
        );
    };
    for (const [sku_id, product] of products) if (!usable(product)) products.delete(sku_id);
    for (const [sku_id, item] of items) if (item.type === CollectibleItemType.PROFILE_EFFECT && !Array.isArray(item.effects)) items.delete(sku_id);
    for (const category of categories) {
        category.products = category.products.filter(usable);
        if (Array.isArray(category.hero_ranking)) category.hero_ranking = category.hero_ranking.filter((sku_id) => products.has(sku_id));
    }

    return { categories, products, items };
};

const download = async ({ url, file }: Source) => {
    if (!EXTERNAL_REFRESH || !url) return undefined;
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch(() => undefined);
    if (!res?.ok) {
        console.error(`[Collectibles] could not fetch ${url}: ${res?.status ?? "network error"}`);
        return undefined;
    }
    const raw = await res.text().catch(() => undefined);
    if (!raw) return undefined;
    try {
        if (!Array.isArray(JSON.parse(raw))) throw new Error("not an array");
    } catch (e) {
        console.error(`[Collectibles] ${url} is invalid`, e);
        return undefined;
    }
    return raw;
};

const read = async (source: Source) => {
    const stat = await fs.stat(source.file).catch(() => undefined);
    return {
        raw: stat ? await fs.readFile(source.file, "utf8").catch(() => undefined) : undefined,
        stale: !stat || Date.now() - stat.mtimeMs > REFRESH_MS,
    };
};

type RefreshStatus = {
    at: string;
    ok: boolean;
    categories?: number;
    products?: number;
    error?: string;
};
let lastRefresh: RefreshStatus | null = null;

let refreshing: Promise<RefreshStatus> | undefined;
const refreshOnce = async () => {
    const generation = catalogGeneration;
    if (!EXTERNAL_REFRESH || !SOURCES.catalog.url) {
        const next = await load(false);
        if (generation === catalogGeneration) catalog = Promise.resolve(next);
        const missing = !(await fs.stat(SOURCES.catalog.file).catch(() => undefined));
        lastRefresh = {
            at: new Date().toISOString(),
            ok: true,
            categories: next.categories.length,
            products: next.products.size,
            ...(missing
                ? {
                      error: `There is no catalogue to load. Put a collectibles.json snapshot in the assets folder, or set COLLECTIBLES_EXTERNAL_REFRESH=true and COLLECTIBLES_CATALOG_URL to download one.`,
                  }
                : {}),
        };
        return lastRefresh;
    }
    const [raw, effectsRaw] = await Promise.all([download(SOURCES.catalog), download(SOURCES.effects)]);
    if (!raw) {
        lastRefresh = {
            at: new Date().toISOString(),
            ok: false,
            error: `Could not download ${SOURCES.catalog.url}`,
        };
        return lastRefresh;
    }
    const next = await withCustom(parse(raw, effectsRaw ?? (await fs.readFile(SOURCES.effects.file, "utf8").catch(() => undefined))));
    const save = async (source: Source, data: string | undefined) => {
        if (!data) return;
        const temporary = `${source.file}.${process.pid}.tmp`;
        try {
            await fs.writeFile(temporary, data);
            await fs.rename(temporary, source.file);
        } catch (error) {
            await fs.unlink(temporary).catch(() => undefined);
            console.error(`[Collectibles] could not cache ${path.basename(source.file)}`, error);
        }
    };
    await Promise.all([save(SOURCES.catalog, raw), save(SOURCES.effects, effectsRaw)]);
    if (generation === catalogGeneration) catalog = Promise.resolve(next);
    console.log(`[Collectibles] refreshed catalog: ${next.categories.length} categories, ${next.products.size} products`);
    lastRefresh = {
        at: new Date().toISOString(),
        ok: true,
        categories: next.categories.length,
        products: next.products.size,
        ...(effectsRaw
            ? {}
            : {
                  error: `Kept the cached profile effects, ${SOURCES.effects.url} could not be downloaded`,
              }),
    };
    return lastRefresh;
};

const refresh = () => {
    if (refreshing) return refreshing;
    if (stopping)
        return Promise.resolve({
            at: new Date().toISOString(),
            ok: false,
            error: "Server is shutting down",
        } satisfies RefreshStatus);
    refreshing = refreshOnce()
        .catch((error) => {
            lastRefresh = {
                at: new Date().toISOString(),
                ok: false,
                error: error instanceof Error ? error.message : "Could not refresh catalog",
            };
            return lastRefresh;
        })
        .finally(() => {
            refreshing = undefined;
        });
    return refreshing;
};

ProcessLifecycle.eventEmitter.on("stopping", async () => {
    stopping = true;
    clearInterval(refreshTimer);
    refreshTimer = undefined;
    await Promise.allSettled([refreshing, catalog]);
});

const sourceStatus = async ({ url, file }: Source) => {
    const stat = await fs.stat(file).catch(() => undefined);
    return {
        url: url ?? null,
        external_refresh_enabled: EXTERNAL_REFRESH && !!url,
        file: path.basename(file),
        size: stat?.size ?? null,
        updated_at: stat?.mtime.toISOString() ?? null,
    };
};

const load = async (backgroundRefresh = true): Promise<Catalog> => {
    if (!stopping && backgroundRefresh && EXTERNAL_REFRESH && SOURCES.catalog.url) refreshTimer ??= setInterval(() => void refresh(), REFRESH_MS).unref();
    const [catalogFile, effectsFile] = await Promise.all([read(SOURCES.catalog), read(SOURCES.effects)]);
    if (!stopping && backgroundRefresh && EXTERNAL_REFRESH && SOURCES.catalog.url && (catalogFile.stale || effectsFile.stale)) void refresh();
    if (catalogFile.raw) {
        try {
            return withCustom(parse(catalogFile.raw, effectsFile.raw));
        } catch (error) {
            console.error("[Collectibles] could not parse local snapshots", error);
        }
    }
    return withCustom(parse("[]"));
};

const listedSkus = (category: CollectibleCategory) => category.products.map((x) => x.sku_id);

export type CollectibleSearchItemType = "AVATAR_DECORATION" | "PROFILE_EFFECT" | "NAMEPLATE" | "PROFILE_FRAME" | "BUNDLE";
export interface CollectibleSearchOptions {
    item_types?: string[];
    search?: string;
    sort_type?: string; // recency | popularity | relevance | alphabetical | price
    sort_direction?: string; // asc | desc
    offset?: number;
    limit?: number;
    first_party?: boolean; // false lists only collabs
}

const SEARCH_TYPES: Record<CollectibleSearchItemType, CollectibleItemType> = {
    AVATAR_DECORATION: CollectibleItemType.AVATAR_DECORATION,
    PROFILE_EFFECT: CollectibleItemType.PROFILE_EFFECT,
    NAMEPLATE: CollectibleItemType.NAMEPLATE,
    PROFILE_FRAME: CollectibleItemType.PROFILE_FRAME,
    BUNDLE: CollectibleItemType.BUNDLE,
};

// what a product counts as for the shop's item type filter; a variants group counts as what its variants are
const searchType = (product: CollectibleProduct): CollectibleItemType | undefined => {
    if (product.type === CollectibleItemType.VARIANTS_GROUP) return product.variants?.[0]?.type;
    return product.type in CollectibleItemType ? product.type : undefined;
};

const searchText = (product: CollectibleProduct, category: CollectibleCategory) =>
    [product.name, product.summary, category.name, ...(product.items ?? []).flatMap((item) => [item.label, item.title, item.description])]
        .filter((x): x is string => typeof x === "string")
        .join(" ")
        .toLowerCase();

type SearchEntry = {
    product: CollectibleProduct;
    category: CollectibleCategory;
    type: CollectibleItemType;
    text?: string;
    name?: string;
    recency?: bigint;
};
let searchIndex: { snapshot: Catalog; entries: SearchEntry[]; sorted: Map<string, SearchEntry[]> } | undefined;
const searchableTypes = new Set(Object.values(SEARCH_TYPES));
const getSearchIndex = (snapshot: Catalog) => {
    if (searchIndex?.snapshot === snapshot) return searchIndex;
    const seen = new Set<string>();
    const entries: SearchEntry[] = [];
    for (const category of snapshot.categories)
        for (const product of category.products) {
            if (seen.has(product.sku_id)) continue;
            seen.add(product.sku_id);
            const type = searchType(product);
            if (type !== undefined && searchableTypes.has(type)) entries.push({ product, category, type });
        }
    return (searchIndex = { snapshot, entries, sorted: new Map() });
};
const compareRecency = (a: SearchEntry, b: SearchEntry) => {
    const left = (a.recency ??= steamFrameRecency(a.product.sku_id) ?? BigInt(a.product.sku_id));
    const right = (b.recency ??= steamFrameRecency(b.product.sku_id) ?? BigInt(b.product.sku_id));
    return left > right ? 1 : left < right ? -1 : 0;
};
const orderedSearchEntries = (index: ReturnType<typeof getSearchIndex>, alphabetical: boolean, direction: number) => {
    const key = `${alphabetical ? "name" : "recency"}:${direction}`;
    let ordered = index.sorted.get(key);
    if (!ordered) {
        ordered = index.entries.slice().sort((a, b) => direction * (alphabetical ? a.product.name.localeCompare(b.product.name) : compareRecency(a, b)));
        index.sorted.set(key, ordered);
    }
    return ordered;
};

export const Collectibles = {
    get: () => (catalog ??= load()),

    refresh,

    setCustomSource(source: () => Promise<CustomCollectibles>) {
        customSource = source;
        catalogGeneration++;
        catalog = undefined;
    },

    /** Rebuilds the catalog from the cached files, for when the custom packs change. */
    reload() {
        catalogGeneration++;
        catalog = undefined;
    },

    async status() {
        const [catalogSource, effectsSource] = await Promise.all([sourceStatus(SOURCES.catalog), sourceStatus(SOURCES.effects)]);
        const loaded = catalog ? await catalog : null;
        return {
            catalog: catalogSource,
            effects: effectsSource,
            refresh_interval_hours: REFRESH_MS / 3_600_000,
            loaded: loaded
                ? {
                      categories: loaded.categories.length,
                      products: loaded.products.size,
                      items: loaded.items.size,
                  }
                : null,
            last_refresh: lastRefresh,
        };
    },

    async categories() {
        return (await Collectibles.get()).categories;
    },

    /** Every pack of the mirrored catalog, including hidden ones. */
    async builtinCategories() {
        const loaded = await Collectibles.get();
        return loaded.builtin ?? loaded.categories;
    },

    async product(sku_id: string) {
        return (await Collectibles.get()).products.get(sku_id);
    },

    async item(sku_id: string, type: CollectibleItemType) {
        const { items, products } = await Collectibles.get();
        const item = items.get(sku_id) ?? products.get(sku_id)?.items.find((x) => x.type === type);
        return item?.type === type ? item : undefined;
    },

    async grantable(sku_id: string) {
        const product = await Collectibles.product(sku_id);
        if (!product) return [];
        if (product.type === CollectibleItemType.BUNDLE) return [product.sku_id, ...(product.bundled_products ?? []).map((x) => x.sku_id)];
        if (product.type === CollectibleItemType.VARIANTS_GROUP) return (product.variants ?? []).map((x) => x.sku_id);
        return [product.sku_id];
    },

    /** The shop's search and browse tabs: listed products filtered and sorted, as SKU ids the client looks up in what it loaded. */
    async search(options: CollectibleSearchOptions) {
        const wanted = new Set((options.item_types ?? []).flatMap((type) => (type in SEARCH_TYPES ? [SEARCH_TYPES[type as CollectibleSearchItemType]] : [])));
        const terms = (options.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const direction = options.sort_direction === "asc" ? 1 : -1;
        const index = getSearchIndex(await Collectibles.get());
        const relevance = options.sort_type === "relevance";
        const entries =
            options.sort_type === "popularity"
                ? direction === -1
                    ? index.entries
                    : index.entries.slice().reverse()
                : relevance && terms.length
                  ? index.entries
                  : orderedSearchEntries(index, options.sort_type === "alphabetical" || options.sort_type === "price", relevance ? -1 : direction);
        const found: { entry: SearchEntry; score: number }[] = [];
        for (const entry of entries) {
            if (wanted.size && !wanted.has(entry.type)) continue;
            if (options.first_party === false && entry.product.is_first_party !== false) continue;
            let score = 0;
            if (terms.length) {
                const text = (entry.text ??= searchText(entry.product, entry.category));
                if (!terms.every((term) => text.includes(term))) continue;
                if (relevance) {
                    const name = (entry.name ??= entry.product.name.toLowerCase());
                    score = terms.reduce((sum, term) => sum + (name === term ? 4 : name.startsWith(term) ? 3 : name.includes(term) ? 2 : 1), 0);
                }
            }
            found.push({ entry, score });
        }
        if (relevance && terms.length) found.sort((a, b) => direction * (a.score - b.score) || -compareRecency(a.entry, b.entry));

        const offset = Math.max(0, options.offset ?? 0);
        const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
        return {
            skus: found.slice(offset, offset + limit).map((x) => x.entry.product.sku_id),
            pagination: { offset, limit, total: found.length, has_more: offset + limit < found.length },
        };
    },

    async shop() {
        const listed = (await Collectibles.categories()).filter((x) => x.products.length);
        const [hero, ...rest] = listed;
        const ranked = listed.flatMap(listedSkus);
        return {
            shop_blocks: [
                ...(hero
                    ? [
                          {
                              type: 0,
                              category_sku_id: hero.sku_id,
                              category_store_listing_id: hero.store_listing_id ?? hero.sku_id,
                              name: hero.name,
                              title: hero.hero_block_title ?? hero.name,
                              summary: hero.summary ?? "",
                              ranked_sku_ids: hero.hero_ranking ?? listedSkus(hero),
                              unpublished_at: null,
                              banner_text_color: hero.banner_text_color ?? null,
                              hero_banner_url: hero.hero_banner_url ?? hero.catalog_banner_url ?? null,
                              hero_banner_animated_url: hero.hero_banner_animated_url ?? null,
                              hero_logo_url: hero.hero_logo_url ?? hero.logo_url ?? null,
                              mobile_hero_url: hero.mobile_hero_url ?? null,
                              banner_display_config: hero.hero_banner_display_config ?? null,
                              logo_display_config: hero.hero_logo_display_config ?? null,
                          },
                      ]
                    : []),
                {
                    type: 1,
                    subblocks: rest
                        .filter((x) => x.featured_block_url)
                        .slice(0, 3)
                        .map((category) => ({
                            type: 0,
                            category_store_listing_id: category.store_listing_id ?? category.sku_id,
                            category_sku_id: category.sku_id,
                            name: category.name,
                            unpublished_at: null,
                            body_text: category.summary?.trim() || null,
                            banner_text_color: null,
                            banner_url: category.featured_block_url,
                            asset_url: category.logo_url ?? null,
                        })),
                },
                { type: 2, ranked_sku_ids: ranked, sorted_sku_ids: { recommended: null, popular: ranked } },
            ],
            categories: listed,
        };
    },
};
