import { Sticker, StickerPack, getDatabase } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { StickerType } from "@spacebar/schemas";

interface UpstreamSticker {
    id: string;
    name: string;
    description: string | null;
    tags: string;
    format_type: number;
    pack_id: string;
    sort_value?: number;
}

interface UpstreamPack {
    id: string;
    sku_id?: string;
    name: string;
    description?: string;
    cover_sticker_id?: string;
    banner_asset_id?: string;
    stickers: UpstreamSticker[];
}

let importing: Promise<void> | undefined;
let lastAttempt = 0;

export function ensureStandardStickerPacks(): Promise<void> {
    if (!Config.get().externalRequests.discordStickerPacks) return Promise.resolve();
    if (importing) return importing;
    if (Date.now() - lastAttempt < 60 * 60 * 1000) return Promise.resolve();
    importing = (async () => {
        lastAttempt = Date.now();
        if ((await StickerPack.count()) > 0) return;
        const upstream = process.env.STICKER_PACKS_UPSTREAM ?? "https://discord.com/api/v9/sticker-packs";
        if (upstream === "off") return;
        const url = new URL(upstream);
        if (url.protocol !== "https:" || url.username || url.password || url.port) return;
        if (url.hostname !== "discord.com" && !Config.get().externalRequests.thirdParty) return;
        const response = await fetch(upstream, {
            signal: AbortSignal.timeout(15000),
            redirect: "error",
        });
        if (!response.ok) throw new Error(`sticker pack import failed with ${response.status}`);
        const { sticker_packs } = (await response.json()) as { sticker_packs: UpstreamPack[] };
        await getDatabase()!.transaction(async (manager) => {
            for (const pack of sticker_packs) {
                await manager.insert(StickerPack, {
                    id: pack.id,
                    sku_id: pack.sku_id,
                    name: pack.name,
                    description: pack.description,
                    banner_asset_id: pack.banner_asset_id,
                });
                await manager.insert(
                    Sticker,
                    pack.stickers.map((sticker) => ({
                        id: sticker.id,
                        name: sticker.name,
                        description: sticker.description ?? undefined,
                        tags: sticker.tags,
                        type: StickerType.STANDARD,
                        format_type: sticker.format_type,
                        available: true,
                        pack_id: pack.id,
                        sort_value: sticker.sort_value,
                    })),
                );
                if (pack.cover_sticker_id)
                    await manager.query(`UPDATE sticker_packs SET cover_sticker_id = CAST($1 AS varchar), "coverStickerId" = CAST($1 AS bigint) WHERE id = $2`, [
                        pack.cover_sticker_id,
                        pack.id,
                    ]);
            }
        });
        console.log(`[StickerPacks] imported ${sticker_packs.length} standard sticker packs`);
    })()
        .catch((error) => console.error("[StickerPacks]", error))
        .finally(() => {
            importing = undefined;
        });
    return importing;
}
