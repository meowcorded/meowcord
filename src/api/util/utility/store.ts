import { isSqlite, sqlArrayIncludes } from "@spacebar/database/Sql";
import { HTTPError } from "lambert-server/HTTPError";
import type { EntityManager } from "typeorm";
import { StoreHiddenPack, StoreItem, StorePack } from "@spacebar/database";
import { CollectibleCategory, CollectibleItem, CollectibleItemType, CollectibleProduct, Collectibles, Config, deleteFile, Snowflake, uploadFile } from "@spacebar/util";

// the admin panel's store: its packs and items, turned into the shapes discord's catalog uses, so the client's shop,
// claiming and equipping treat them like any other collectible

export const STORE_ITEM_TYPES = [CollectibleItemType.AVATAR_DECORATION, CollectibleItemType.PROFILE_EFFECT, CollectibleItemType.NAMEPLATE, CollectibleItemType.PROFILE_FRAME];
export const NAMEPLATE_PALETTES = ["crimson", "berry", "sky", "teal", "forest", "bubble_gum", "violet", "cobalt", "clover", "lemon", "white", "black"];

const DEFAULT_SUMMARIES: Record<number, string> = {
    [CollectibleItemType.AVATAR_DECORATION]: "Give your avatar a new look.",
    [CollectibleItemType.PROFILE_EFFECT]: "Show this effect when others view your profile.",
    [CollectibleItemType.NAMEPLATE]: "Make your name stand out in servers and chats.",
    [CollectibleItemType.PROFILE_FRAME]: "Elevate and wrap your profile with a frame.",
};

// profile frames are drawn at this width, with this much art past each side
export const FRAME_INNER_WIDTH = 1200;
export const FRAME_OVERFLOW_HORIZONTAL = 56;
// profile effects play over the whole profile card at this size
export const EFFECT_WIDTH = 450;
export const EFFECT_HEIGHT = 880;

const STYLES = {
    background_colors: [5793266, 2303786],
    button_colors: [5793266, 5793266],
    confetti_colors: [43772, 15774258, 16414587, 3000177, 9739511],
};
// everything on this instance is free; the client still wants a price to show
const FREE = {
    country_prices: { country_code: "US", prices: [{ amount: 0, currency: "usd", exponent: 2 }] },
};

const ANIMATED_TYPES = ["image/apng", "image/gif", "image/gifv"];

const artUrl = (path: string, hash?: string) => `${Config.get().cdn.endpointPublic?.replace(/\/+$/, "")}/media/v1/collectibles-shop/${path}${hash ? `?v=${hash}` : ""}`;

/** Uploads a data: URI to media/v1/collectibles-shop/<path>; returns its hash and type. */
export async function uploadStoreArt(path: string, dataUri: string, field: string) {
    const match = /^data:([\w.+/-]+);base64,(.+)$/s.exec(dataUri);
    if (!match) throw new HTTPError(`${field} must be a data: URI`, 400);
    const result = (await uploadFile(`/media/v1/collectibles-shop/${path}`, {
        buffer: Buffer.from(match[2], "base64"),
        mimetype: match[1],
        originalname: field,
    }).catch((e) => {
        throw new HTTPError(`${field}: ${e?.message ?? "the CDN refused the file"}`, 400);
    })) as unknown as { hash: string; content_type: string };
    return { hash: result.hash, contentType: result.content_type };
}

export const isAnimatedArt = (dataUri: string) => ANIMATED_TYPES.some((type) => dataUri.startsWith(`data:${type};`)) || isAnimatedPng(dataUri);

// browsers report APNGs as image/png, so look for the animation chunk
const isAnimatedPng = (dataUri: string) => {
    if (!dataUri.startsWith("data:image/png;")) return false;
    const head = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1, dataUri.indexOf(",") + 1 + 4096), "base64");
    return head.includes("acTL");
};

export const deleteStoreArt = (path: string) => deleteFile(`/media/v1/collectibles-shop/${path}`).catch(() => undefined);

/** Where each uploaded slot of an item lives under its SKU; frame layers go where the client asks, <sku>/<layer id>/static. */
export const artPath = (item: Pick<StoreItem, "id">, slot: string) => (slot.startsWith("layer:") ? `${item.id}/${slot.slice("layer:".length)}/static` : `${item.id}/${slot}`);

function toCatalogItem(item: StoreItem): CollectibleItem | null {
    const assets = item.data.assets ?? {};
    const base = { type: item.type as CollectibleItemType, sku_id: item.id };
    switch (item.type) {
        case CollectibleItemType.AVATAR_DECORATION: {
            const hash = (assets.animated ?? assets.static)?.replace(/^a_/, "");
            if (!hash) return null;
            return { ...base, asset: assets.animated ? `a_${hash}` : hash, label: item.label };
        }
        case CollectibleItemType.NAMEPLATE:
            if (!assets.static) return null;
            return {
                ...base,
                asset: `nameplates/custom/${item.id}/`,
                label: item.label,
                palette: item.data.palette ?? "violet",
            };
        case CollectibleItemType.PROFILE_EFFECT: {
            if (!assets.effect) return null;
            const effect = artUrl(artPath(item, "effect"), assets.effect);
            const thumbnail = assets.thumbnail ? artUrl(artPath(item, "thumbnail"), assets.thumbnail) : effect;
            return {
                ...base,
                id: item.id,
                title: item.name,
                description: item.summary || DEFAULT_SUMMARIES[item.type],
                accessibilityLabel: item.label,
                animationType: 2,
                thumbnailPreviewSrc: thumbnail,
                reducedMotionSrc: assets.reduced ? artUrl(artPath(item, "reduced"), assets.reduced) : thumbnail,
                effects: [
                    {
                        src: effect,
                        loop: item.data.loop ?? true,
                        height: EFFECT_HEIGHT,
                        width: EFFECT_WIDTH,
                        duration: item.data.duration ?? 3000,
                        start: 0,
                        loopDelay: 0,
                        position: { x: 0, y: 0 },
                        zIndex: 100,
                        randomizedSources: [],
                    },
                ],
            };
        }
        case CollectibleItemType.PROFILE_FRAME: {
            const layers = (item.data.layers ?? []).filter((layer) => assets[`layer:${layer.id}`]);
            if (!layers.length) return null;
            return {
                ...base,
                label: item.label,
                layers: layers.map((layer) => ({
                    id: layer.id,
                    type: "staple",
                    order: layer.order,
                    anchor: layer.anchor,
                    responsive: false,
                })),
                inner_width: FRAME_INNER_WIDTH,
                overflow_top: item.data.overflow_top ?? 0,
                overflow_bottom: item.data.overflow_bottom ?? 0,
                overflow_horizontal: FRAME_OVERFLOW_HORIZONTAL,
            };
        }
        default:
            return null;
    }
}

function toProduct(item: StoreItem, catalogItem: CollectibleItem): CollectibleProduct {
    return {
        sku_id: item.id,
        store_listing_id: item.id,
        name: item.name,
        summary: item.summary || DEFAULT_SUMMARIES[item.type],
        styles: STYLES,
        preview_assets: null,
        items: [catalogItem],
        type: item.type,
        premium_type: 2,
        hide_badge: true,
        unpublished_at: null,
        category_sku_id: item.pack_id,
        prices: { "0": FREE, "4": FREE },
        google_sku_ids: {},
        is_first_party: true,
    };
}

export const packArtUrl = (pack: StorePack, slot: "banner" | "logo") => {
    const hash = slot === "banner" ? pack.banner_hash : pack.logo_hash;
    return hash ? artUrl(`${pack.id}/${slot}`, hash) : null;
};

export const sortStoreByPosition = <T extends { id: string; position: number; created_at: Date }>(a: T, b: T) =>
    a.position - b.position || +a.created_at - +b.created_at || a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function customCollectibles() {
    const [packs, items, hidden] = await Promise.all([StorePack.find(), StoreItem.find(), StoreHiddenPack.find()]);
    const grouped = groupStoreItems(items);
    const categories: CollectibleCategory[] = packs.sort(sortStoreByPosition).map((pack) => {
        const products = (grouped.get(pack.id) ?? []).flatMap((item) => {
            const catalogItem = toCatalogItem(item);
            return catalogItem ? [toProduct(item, catalogItem)] : [];
        });
        const banner = packArtUrl(pack, "banner");
        return {
            sku_id: pack.id,
            name: pack.name,
            summary: pack.summary || " ",
            store_listing_id: pack.id,
            styles: STYLES,
            hero_ranking: products.map((x) => x.sku_id),
            products,
            hero_banner_url: banner,
            catalog_banner_url: banner,
            featured_block_url: banner,
            mobile_banner_url: banner,
            logo_url: packArtUrl(pack, "logo"),
            pdp_bg_url: null,
            mobile_bg_url: null,
            unpublished_at: null,
        };
    });
    return {
        categories,
        hidden: hidden.filter((x) => x.hidden !== false).map((x) => x.sku_id),
        overrides: Object.fromEntries(
            hidden.map((pack) => {
                const metadata = pack.customization ?? {};
                return [
                    pack.sku_id,
                    {
                        ...(metadata.name !== undefined ? { name: metadata.name } : {}),
                        ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
                        ...(metadata.position !== undefined ? { position: metadata.position } : {}),
                        ...(metadata.banner_hash ? { banner_url: artUrl(`builtin/${pack.sku_id}/banner`, metadata.banner_hash) } : {}),
                        ...(metadata.logo_hash ? { logo_url: artUrl(`builtin/${pack.sku_id}/logo`, metadata.logo_hash) } : {}),
                    },
                ];
            }),
        ),
    };
}

/** Whether a store item has the art it needs to show up in the shop. */
export const storeItemComplete = (item: StoreItem) => toCatalogItem(item) !== null;

Collectibles.setCustomSource(customCollectibles);

// the art an admin can upload per item type; a data: URI uploads it, null removes it
export type StoreArtInput = Partial<Record<"image" | "static" | "motion" | "effect" | "thumbnail" | "reduced" | FrameSlot, string | null>>;
type FrameSlot = "front_top" | "front_bottom" | "back_top" | "back_bottom";
const FRAME_SLOTS: FrameSlot[] = ["front_top", "front_bottom", "back_top", "back_bottom"];

const setSlot = async (item: StoreItem, slot: string, data: string | null | undefined, field: string) => {
    if (data === undefined) return;
    const assets = (item.data.assets ??= {});
    if (data === null) {
        if (assets[slot]) await deleteStoreArt(artPath(item, slot));
        delete assets[slot];
        return;
    }
    assets[slot] = (await uploadStoreArt(artPath(item, slot), data, field)).hash;
};

/** Uploads or removes the art in \`art\` for the item's type, updating item.data. */
export async function applyStoreArt(item: StoreItem, art: StoreArtInput = {}) {
    switch (item.type) {
        case CollectibleItemType.AVATAR_DECORATION:
            // animated decorations live in the animated slot, still ones in static; the client asks for animated first
            if (art.image !== undefined) {
                const animated = !!art.image && isAnimatedArt(art.image);
                // upload first, so a refused file leaves the old art in place
                await setSlot(item, animated ? "animated" : "static", art.image, "image");
                await setSlot(item, animated ? "static" : "animated", null, "image");
            }
            break;
        case CollectibleItemType.NAMEPLATE:
            if (art.static && isAnimatedArt(art.static)) throw new HTTPError("The nameplate's still image can't be animated, upload the animation as its motion", 400);
            await setSlot(item, "static", art.static, "static");
            // the client plays a video, or an animated image where it can't
            if (art.motion !== undefined) {
                const video = !!art.motion && /^data:video\//.test(art.motion);
                await setSlot(item, video ? "video" : "animated", art.motion, "motion");
                await setSlot(item, video ? "animated" : "video", null, "motion");
            }
            break;
        case CollectibleItemType.PROFILE_EFFECT:
            await setSlot(item, "effect", art.effect, "effect");
            await setSlot(item, "thumbnail", art.thumbnail, "thumbnail");
            await setSlot(item, "reduced", art.reduced, "reduced");
            break;
        case CollectibleItemType.PROFILE_FRAME: {
            const replacements = new Map<FrameSlot, { id: string; hash: string }>();
            try {
                for (const slot of FRAME_SLOTS) {
                    const data = art[slot];
                    if (!data) continue;
                    const id = Snowflake.generate();
                    const uploaded = await uploadStoreArt(artPath(item, `layer:${id}`), data, slot);
                    replacements.set(slot, { id, hash: uploaded.hash });
                }
            } catch (error) {
                await deleteStoreArtPaths(Array.from(replacements.values(), ({ id }) => artPath(item, `layer:${id}`)));
                throw error;
            }
            for (const slot of FRAME_SLOTS) {
                if (art[slot] === undefined) continue;
                const [order, anchor] = slot.split("_") as ["front" | "back", "top" | "bottom"];
                const layers = (item.data.layers ??= []);
                const old = layers.find((layer) => layer.order === order && layer.anchor === anchor);
                if (old) {
                    await setSlot(item, `layer:${old.id}`, null, slot);
                    layers.splice(layers.indexOf(old), 1);
                }
                const replacement = replacements.get(slot);
                if (!replacement) continue;
                layers.push({ id: replacement.id, order, anchor });
                (item.data.assets ??= {})[`layer:${replacement.id}`] = replacement.hash;
            }
            break;
        }
        default:
            break;
    }
}

const MAIN_ART: Record<number, (keyof StoreArtInput)[]> = {
    [CollectibleItemType.AVATAR_DECORATION]: ["image"],
    [CollectibleItemType.PROFILE_EFFECT]: ["effect"],
    [CollectibleItemType.NAMEPLATE]: ["static"],
};

/** Refuses art changes that would leave the item without its main art, before anything is deleted. */
export function assertKeepsMainArt(item: StoreItem, art: StoreArtInput = {}) {
    const removed = (MAIN_ART[item.type] ?? []).some((slot) => art[slot] === null);
    const frameLeft =
        item.type !== CollectibleItemType.PROFILE_FRAME ||
        FRAME_SLOTS.some((slot) => art[slot] || (art[slot] === undefined && item.data.layers?.some((layer) => `${layer.order}_${layer.anchor}` === slot)));
    if (removed || !frameLeft) throw new HTTPError("That would remove the item's main art; upload a replacement instead", 400);
}

/** Removes every uploaded file of an item. */
export async function deleteStoreArtPaths(paths: Iterable<string>): Promise<void> {
    const iterator = paths[Symbol.iterator]();
    await Promise.all(
        Array.from({ length: 8 }, async () => {
            for (let next = iterator.next(); !next.done; next = iterator.next()) await deleteStoreArt(next.value);
        }),
    );
}

export const deleteAllStoreArt = (item: StoreItem) => deleteStoreArtPaths(Object.keys(item.data.assets ?? {}).map((slot) => artPath(item, slot)));

/** Deletes pack art with one concurrency budget for the entire pack. */
export function deleteStorePackArt(pack: StorePack, items: StoreItem[]) {
    function* paths() {
        yield `${pack.id}/banner`;
        yield `${pack.id}/logo`;
        for (const item of items) for (const slot of Object.keys(item.data.assets ?? {})) yield artPath(item, slot);
    }
    return deleteStoreArtPaths(paths());
}

const previewUrl = (item: StoreItem, slot: string) => {
    const hash = item.data.assets?.[slot];
    return hash ? `/media/v1/collectibles-shop/${artPath(item, slot)}?v=${hash}` : null;
};

export function serializeStoreItem(item: StoreItem) {
    const art: Record<string, string | null> = {};
    switch (item.type) {
        case CollectibleItemType.AVATAR_DECORATION:
            art.image = previewUrl(item, "animated") ?? previewUrl(item, "static");
            break;
        case CollectibleItemType.NAMEPLATE:
            art.static = previewUrl(item, "static");
            art.motion = previewUrl(item, "video") ?? previewUrl(item, "animated");
            break;
        case CollectibleItemType.PROFILE_EFFECT:
            art.effect = previewUrl(item, "effect");
            art.thumbnail = previewUrl(item, "thumbnail");
            art.reduced = previewUrl(item, "reduced");
            break;
        case CollectibleItemType.PROFILE_FRAME:
            for (const slot of FRAME_SLOTS) {
                const layer = item.data.layers?.find((x) => `${x.order}_${x.anchor}` === slot);
                art[slot] = layer ? previewUrl(item, `layer:${layer.id}`) : null;
            }
            break;
        default:
            break;
    }
    return {
        id: item.id,
        pack_id: item.pack_id,
        type: item.type,
        name: item.name,
        summary: item.summary,
        label: item.label,
        palette: item.data.palette ?? null,
        duration: item.data.duration ?? null,
        loop: item.data.loop ?? true,
        overflow_top: item.data.overflow_top ?? null,
        overflow_bottom: item.data.overflow_bottom ?? null,
        position: item.position,
        art,
        complete: storeItemComplete(item),
    };
}

/** Group and sort once when serializing a collection of packs. */
export function groupStoreItems(items: StoreItem[]): Map<string, StoreItem[]> {
    const grouped = new Map<string, StoreItem[]>();
    for (const item of items) {
        const packId = item.pack_id;
        const siblings = grouped.get(packId);
        if (siblings) siblings.push(item);
        else grouped.set(packId, [item]);
    }
    for (const siblings of grouped.values()) siblings.sort(sortStoreByPosition);
    return grouped;
}

export const serializeStorePack = (pack: StorePack, items: StoreItem[] | Map<string, StoreItem[]> = []) => ({
    id: pack.id,
    name: pack.name,
    summary: pack.summary,
    position: pack.position,
    banner: pack.banner_hash ? `/media/v1/collectibles-shop/${pack.id}/banner?v=${pack.banner_hash}` : null,
    logo: pack.logo_hash ? `/media/v1/collectibles-shop/${pack.id}/logo?v=${pack.logo_hash}` : null,
    created_at: pack.created_at,
    items: (items instanceof Map ? (items.get(pack.id) ?? []) : items.filter((item) => item.pack_id === pack.id).sort(sortStoreByPosition)).map(serializeStoreItem),
});

/** Sets an item's type-specific settings from a create or update body. */
export function applyStoreItemSettings(
    item: StoreItem,
    body: {
        palette?: string;
        duration?: number;
        loop?: boolean;
        overflow_top?: number;
        overflow_bottom?: number;
    },
) {
    if (body.palette !== undefined) {
        if (!NAMEPLATE_PALETTES.includes(body.palette)) throw new HTTPError(`palette must be one of ${NAMEPLATE_PALETTES.join(", ")}`, 400);
        item.data.palette = body.palette;
    }
    if (body.duration !== undefined) item.data.duration = body.duration;
    if (body.loop !== undefined) item.data.loop = body.loop;
    if (body.overflow_top !== undefined) item.data.overflow_top = body.overflow_top;
    if (body.overflow_bottom !== undefined) item.data.overflow_bottom = body.overflow_bottom;
}

export async function clearStoreSelections(manager: EntityManager, skuIds: string[]): Promise<void> {
    if (!skuIds.length) return;
    if (isSqlite()) {
        for (const sku of skuIds) await manager.query('INSERT INTO "store_item_deletions" (sku_id) VALUES ($1) ON CONFLICT DO NOTHING', [sku]);
        for (const table of ["users", "members"]) {
            await manager.query(
                `UPDATE "${table}" SET
                avatar_decoration_data = CASE WHEN ${sqlArrayIncludes("avatar_decoration_data ->> 'sku_id'", "$1")} THEN NULL ELSE avatar_decoration_data END,
                collectibles = CASE WHEN ${sqlArrayIncludes("collectibles -> 'nameplate' ->> 'sku_id'", "$1")} THEN json_set(collectibles, '$.nameplate', NULL) ELSE collectibles END,
                profile_collectibles = CASE WHEN json_type(profile_collectibles) = 'array' THEN
                    (SELECT json_group_array(json(value)) FROM json_each(profile_collectibles) WHERE (${sqlArrayIncludes("value ->> 'sku_id'", "$1")}) IS NOT TRUE)
                    ELSE profile_collectibles END
                WHERE ${sqlArrayIncludes("avatar_decoration_data ->> 'sku_id'", "$1")}
                    OR ${sqlArrayIncludes("collectibles -> 'nameplate' ->> 'sku_id'", "$1")}
                    OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(profile_collectibles) = 'array' THEN profile_collectibles ELSE '[]' END) entry WHERE ${sqlArrayIncludes("entry.value ->> 'sku_id'", "$1")})`,
                [skuIds],
            );
        }
        return;
    }
    await manager.query(`INSERT INTO "store_item_deletions" (sku_id) SELECT unnest($1::text[]) ON CONFLICT (sku_id) DO NOTHING`, [skuIds]);
    const profileItems = "CASE WHEN jsonb_typeof(profile_collectibles) = 'array' THEN profile_collectibles ELSE '[]'::jsonb END";
    for (const table of ["users", "members"])
        await manager.query(
            `UPDATE "${table}" SET
                avatar_decoration_data = CASE WHEN ${sqlArrayIncludes("avatar_decoration_data ->> 'sku_id'", "$1")} THEN NULL ELSE avatar_decoration_data END,
                collectibles = CASE WHEN ${sqlArrayIncludes("collectibles -> 'nameplate' ->> 'sku_id'", "$1")} THEN jsonb_set(collectibles, '{nameplate}', 'null'::jsonb, false) ELSE collectibles END,
                profile_collectibles = CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(${profileItems}) AS entry WHERE ${sqlArrayIncludes("entry ->> 'sku_id'", "$1")})
                    THEN COALESCE((SELECT jsonb_agg(entry ORDER BY position) FROM jsonb_array_elements(${profileItems}) WITH ORDINALITY AS entries(entry, position)
                        WHERE (${sqlArrayIncludes("entry ->> 'sku_id'", "$1")}) IS NOT TRUE), '[]'::jsonb) ELSE profile_collectibles END
             WHERE ${sqlArrayIncludes("avatar_decoration_data ->> 'sku_id'", "$1")}
                OR ${sqlArrayIncludes("collectibles -> 'nameplate' ->> 'sku_id'", "$1")}
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(${profileItems}) AS entry WHERE ${sqlArrayIncludes("entry ->> 'sku_id'", "$1")})`,
            [skuIds],
        );
}
