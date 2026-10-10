import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { In, Not } from "typeorm";
import { arrayGroupBy } from "@spacebar/extensions";
import { Channel, Emoji, getDatabase, Role, Sticker } from "@spacebar/database";
import { GuildCacheEventId, JSONStringify, listenEvent } from "@spacebar/util";
import { ChannelType, PublicChannel } from "@spacebar/schemas";

export type CachedChannel = PublicChannel & {
    id: string;
    last_message_id?: string | null;
    last_pin_timestamp?: string;
    e2ee_enabled_at?: string | null;
    version?: string;
};

export interface GuildCacheEntry {
    channels: CachedChannel[];
    roles: Role[];
    emojis: Emoji[];
    stickers: Sticker[];
}

const threadTypes = [ChannelType.GUILD_PUBLIC_THREAD, ChannelType.GUILD_PRIVATE_THREAD, ChannelType.GUILD_NEWS_THREAD];
const maxAge = 5 * 60 * 1000;
const maxGuilds = 2000;

const entries = new Map<string, { entry: GuildCacheEntry; at: number }>();
const invalidatedAt = new Map<string, number>();
let generation = 0;
let floor = 0;
let subscription: Promise<boolean> | undefined;

export function invalidateGuildCache(guild_id: string) {
    entries.delete(guild_id);
    invalidatedAt.set(guild_id, ++generation);
    if (invalidatedAt.size <= maxGuilds * 4) return;
    invalidatedAt.clear();
    floor = generation;
}

const subscribe = () =>
    (subscription ??= listenEvent(GuildCacheEventId, (event) => event.data?.guild_id && invalidateGuildCache(event.data.guild_id))
        .then(() => true)
        .catch((e) => {
            console.error("[GuildCache] could not listen for invalidations, caching is off", e);
            return false;
        }));

const plain = <T>(value: unknown) => JSON.parse(JSONStringify(value)) as T;

const dateString = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : undefined);

async function load(guildIds: string[]) {
    const [channels, emojis, roles, stickers] = await Promise.all([
        Channel.find({
            where: { guild_id: In(guildIds), type: Not(In(threadTypes)) },
            relations: { available_tags: true },
        }),
        Emoji.find({ where: { guild_id: In(guildIds) } }),
        Role.find({ where: { guild_id: In(guildIds) } }),
        Sticker.find({ where: { guild_id: In(guildIds) } }),
    ]);
    const channelsByGuild = arrayGroupBy(channels, (c) => c.guild_id!);
    const emojisByGuild = arrayGroupBy(emojis, (e) => e.guild_id!);
    const rolesByGuild = arrayGroupBy(roles, (r) => r.guild_id);
    const stickersByGuild = arrayGroupBy(stickers, (s) => s.guild_id!);
    return new Map(
        guildIds.map((id) => [
            id,
            {
                channels: plain<CachedChannel[]>(channelsByGuild.get(id) ?? []),
                roles: plain<Role[]>(rolesByGuild.get(id) ?? []),
                emojis: plain<Emoji[]>(emojisByGuild.get(id) ?? []),
                stickers: plain<Sticker[]>(stickersByGuild.get(id) ?? []),
            } satisfies GuildCacheEntry,
        ]),
    );
}

export async function getGuildCache(guildIds: string[]): Promise<Map<string, GuildCacheEntry>> {
    const result = new Map<string, GuildCacheEntry>();
    if (!guildIds.length) return result;
    const started = ++generation;
    const [cacheable, live] = await Promise.all([
        subscribe(),
        getDatabase()!.query(
            `SELECT id, guild_id, last_message_id, last_pin_timestamp, e2ee_enabled_at, version FROM channels WHERE ${sqlArrayIncludes("guild_id", "$1")} AND NOT (${sqlArrayIncludes("type", "$2")})`,
            [guildIds, threadTypes],
        ) as Promise<
            {
                id: string;
                guild_id: string;
                last_message_id: string | null;
                last_pin_timestamp: Date | null;
                e2ee_enabled_at: Date | null;
                version: string;
            }[]
        >,
    ]);
    const liveByGuild = arrayGroupBy(live, (c) => c.guild_id);
    const now = Date.now();
    const missing = guildIds.filter((id) => {
        const cached = entries.get(id);
        if (!cached || now - cached.at > maxAge) return true;
        const channels = liveByGuild.get(id) ?? [];
        if (channels.length !== cached.entry.channels.length) return true;
        const known = new Set(cached.entry.channels.map((c) => c.id));
        if (channels.some((c) => !known.has(c.id))) return true;
        result.set(id, cached.entry);
        return false;
    });

    if (missing.length) {
        const loaded = await load(missing);
        for (const [id, entry] of loaded) {
            result.set(id, entry);
            if (!cacheable || Math.max(invalidatedAt.get(id) ?? 0, floor) >= started) continue;
            entries.delete(id);
            entries.set(id, { entry, at: now });
        }
        for (const id of entries.keys()) {
            if (entries.size <= maxGuilds) break;
            entries.delete(id);
        }
    }

    const liveById = new Map(live.map((c) => [c.id, c]));
    for (const [id, entry] of result)
        result.set(id, {
            ...entry,
            channels: entry.channels.map((channel) => {
                const fresh = liveById.get(channel.id);
                if (!fresh) return { ...channel };
                return {
                    ...channel,
                    last_message_id: fresh.last_message_id,
                    version: `${fresh.version}`,
                    last_pin_timestamp: dateString(fresh.last_pin_timestamp),
                    e2ee_enabled_at: fresh.e2ee_enabled_at ? new Date(fresh.e2ee_enabled_at).toISOString().replace("Z", "+00:00") : null,
                };
            }),
        });
    return result;
}
