import { isSqlite, sqlArrayLength, sqlLike } from "@spacebar/database/Sql";
import { HTTPError } from "lambert-server/HTTPError";
import { Brackets, In } from "typeorm";
import { Channel, Message, Recipient, ThreadMember } from "@spacebar/database";
import { FieldErrors, getPermission, MessageFlags } from "@spacebar/util";
import { MessageType } from "@spacebar/schemas";

export type MessageSearchQuery = Record<string, unknown>;

const hasFilters = (): Record<string, string> => ({
    link: isSqlite() ? `(m.content LIKE '%http://%' OR m.content LIKE '%https://%')` : `m.content ~* 'https?://'`,
    embed: `${sqlArrayLength("m.embeds")} > 0`,
    file: `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`,
    image: `(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'image/%') OR ${isSqlite() ? "EXISTS (SELECT 1 FROM json_each(m.embeds) WHERE value ->> 'type' IN ('image', 'gifv'))" : `m.embeds @> '[{"type":"image"}]' OR m.embeds @> '[{"type":"gifv"}]'`})`,
    video: `(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'video/%') OR ${isSqlite() ? "EXISTS (SELECT 1 FROM json_each(m.embeds) WHERE value ->> 'type' = 'video')" : `m.embeds @> '[{"type":"video"}]'`})`,
    sound: `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.content_type LIKE 'audio/%')`,
    sticker: `EXISTS (SELECT 1 FROM message_stickers s WHERE s.message_id = m.id)`,
    poll: `m.poll IS NOT NULL`,
    forward: `m.message_reference->>'type' = '1'`,
    snapshot: `${sqlArrayLength("m.message_snapshots")} > 0`,
});

const SEARCHABLE_TYPES = [MessageType.DEFAULT, MessageType.REPLY, MessageType.APPLICATION_COMMAND, MessageType.CONTEXT_MENU_COMMAND];

const list = (value: unknown): string[] => (value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]).map(String).filter((x) => x.length));

const bool = (value: unknown) => (value === undefined ? undefined : value === true || value === "true");

export async function getSearchableChannels(userId: string, guildId: string | undefined, channelIds: string[]) {
    if (!guildId)
        return (
            await Recipient.find({
                where: { user_id: userId, ...(channelIds.length ? { channel_id: In(channelIds) } : {}) },
                select: { channel_id: true },
            })
        ).map(({ channel_id }) => Channel.create({ id: channel_id }));

    const [permission, channels, threadMemberships] = await Promise.all([
        getPermission(userId, guildId),
        Channel.find({
            where: { guild_id: guildId },
            select: {
                id: true,
                guild_id: true,
                nsfw: true,
                type: true,
                parent_id: true,
                permission_overwrites: true,
            },
        }),
        ThreadMember.find({ where: { user_id: userId }, select: { id: true } }),
    ]);
    const joinedThreads = new Set(threadMemberships.map((x) => x.id));
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const requested = channelIds.length ? new Set(channelIds) : undefined;
    return channels.filter((channel) => {
        if (requested && !requested.has(channel.id)) return false;
        const source = channel.isThread() ? byId.get(channel.parent_id!) : channel;
        if (!source) return false;
        const perms = permission.overwriteChannel(source.permission_overwrites ?? []);
        if (!perms.has("VIEW_CHANNEL") || !perms.has("READ_MESSAGE_HISTORY")) return false;
        return !channel.isPrivateThread() || joinedThreads.has(channel.id) || perms.has("MANAGE_THREADS");
    });
}

export async function searchMessages(userId: string, channels: Channel[], query: MessageSearchQuery) {
    const limit = Number(query.limit ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HTTPError("limit must be between 1 and 100", 422);
    const offset = Number(query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw new HTTPError("offset must be an integer between 0 and 5000", 422);
    const sortOrder = `${query.sort_order ?? "desc"}`.toLowerCase();
    if (sortOrder !== "desc" && sortOrder !== "asc")
        throw FieldErrors({
            sort_order: { message: "Value must be one of ('desc', 'asc').", code: "BASE_TYPE_CHOICES" },
        });

    const includeNsfw = bool(query.include_nsfw) ?? false;
    const channelIds = channels.filter((channel) => includeNsfw || !channel.nsfw).map((channel) => channel.id);
    if (!channelIds.length) return { messages: [] as Message[], total_results: 0 };

    const qb = Message.createQueryBuilder("m")
        .select("m.id", "id")
        .where("m.channel_id IN (:...channelIds)", { channelIds })
        .andWhere("m.type IN (:...types)", { types: SEARCHABLE_TYPES })
        .andWhere("(m.flags & :ephemeral) != :ephemeral", { ephemeral: MessageFlags.FLAGS.EPHEMERAL });

    const words = `${query.content ?? ""}`
        .trim()
        .split(/\s+/)
        .filter((word) => word.length);
    words.forEach((word, i) =>
        qb.andWhere(`${sqlLike("m.content", `:word${i}`)}`, {
            [`word${i}`]: `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
        }),
    );

    const authors = list(query.author_id);
    if (authors.length) qb.andWhere("m.author_id IN (:...authors)", { authors });

    for (const type of list(query.author_type)) {
        const negate = type.startsWith("-");
        const kind = type.replace(/^-/, "");
        const clause =
            kind === "webhook"
                ? "m.webhook_id IS NOT NULL"
                : kind === "bot"
                  ? "EXISTS (SELECT 1 FROM users u WHERE u.id = m.author_id AND u.bot = true) AND m.webhook_id IS NULL"
                  : kind === "user"
                    ? "EXISTS (SELECT 1 FROM users u WHERE u.id = m.author_id AND u.bot = false) AND m.webhook_id IS NULL"
                    : undefined;
        if (clause) qb.andWhere(negate ? `NOT (${clause})` : clause);
    }

    const mentions = list(query.mentions);
    if (mentions.length)
        qb.andWhere(
            new Brackets((b) =>
                b
                    .where("EXISTS (SELECT 1 FROM message_user_mentions mu WHERE mu.message_id = m.id AND mu.user_id IN (:...mentions))", { mentions })
                    .orWhere("m.mention_everyone = true"),
            ),
        );
    if (bool(query.mention_everyone) !== undefined)
        qb.andWhere("COALESCE(m.mention_everyone, false) = :everyone", {
            everyone: bool(query.mention_everyone),
        });

    const has = list(query.has);
    const wanted = has.filter((x) => !x.startsWith("-")).flatMap((x) => hasFilters()[x] ?? []);
    if (wanted.length) qb.andWhere(`(${wanted.join(" OR ")})`);
    for (const clause of has.filter((x) => x.startsWith("-")).flatMap((x) => hasFilters()[x.slice(1)] ?? [])) qb.andWhere(`NOT (${clause})`);

    const pinned = bool(query.pinned);
    if (pinned !== undefined) qb.andWhere(pinned ? "m.pinned_at IS NOT NULL" : "m.pinned_at IS NULL");
    if (query.min_id) qb.andWhere("m.id > :minId", { minId: `${query.min_id}` });
    if (query.max_id) qb.andWhere("m.id < :maxId", { maxId: `${query.max_id}` });

    const total_results = await qb.getCount();
    const ids = (
        await qb
            .orderBy("m.id", sortOrder === "asc" ? "ASC" : "DESC")
            .offset(offset)
            .limit(limit)
            .getRawMany<{ id: string }>()
    ).map(({ id }) => `${id}`);

    const found = ids.length
        ? await Message.find({
              where: { id: In(ids) },
              relationLoadStrategy: "query",
              relations: {
                  author: true,
                  webhook: true,
                  application: true,
                  mentions: true,
                  mention_roles: true,
                  mention_channels: true,
                  sticker_items: true,
                  attachments: true,
              },
          })
        : [];
    await Message.fillReplies(found);
    const byId = new Map(found.map((message) => [message.id, message]));
    const messages = ids.map((id) => byId.get(id)).filter((message): message is Message => !!message);
    return { messages, total_results };
}

export function searchResponse(userId: string, result: { messages: Message[]; total_results: number }) {
    return {
        analytics_id: null,
        doing_deep_historical_index: false,
        total_results: result.total_results,
        messages: result.messages.map((message) => [{ ...message.toPublicJSON(userId), hit: true }]),
        threads: [],
        members: [],
    };
}

export async function searchTabs(userId: string, channels: Channel[], body: { tabs?: Record<string, MessageSearchQuery>; include_nsfw?: boolean }) {
    const entries = Object.entries(body.tabs ?? {});
    if (entries.length > 10) throw new HTTPError("search must contain at most 10 tabs", 422);
    const tabs: Record<string, unknown> = {};
    for (const [name, query] of entries) {
        const result = await searchMessages(userId, channels, {
            include_nsfw: body.include_nsfw,
            ...query,
        });
        const response = searchResponse(userId, result);
        tabs[name] = { ...response, cursor: null };
    }
    return { tabs, analytics_id: null, doing_deep_historical_index: false };
}
