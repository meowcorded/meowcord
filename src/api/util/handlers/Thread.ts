import { isSqlite } from "@spacebar/database/Sql";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";
import { In } from "typeorm";
import { Channel, Member, Message, ThreadMember, ThreadMemberFlags } from "@spacebar/database";
import {
    ChannelFlags,
    DiscordApiErrors,
    emitEvent,
    FieldErrors,
    getPermission,
    InvisibleCharacters,
    Snowflake,
    ThreadCreateEvent,
    ThreadMembersUpdateEvent,
    ThreadUpdatEvent,
} from "@spacebar/util";
import { ChannelType } from "@spacebar/schemas";
import { HTTPError } from "lambert-server/HTTPError";

export const THREAD_TYPES = [ChannelType.GUILD_NEWS_THREAD, ChannelType.GUILD_PUBLIC_THREAD, ChannelType.GUILD_PRIVATE_THREAD];
export const AUTO_ARCHIVE_DURATIONS = [60, 1440, 4320, 10080];
export const AUTO_ARCHIVE_DURATION_ERROR = {
    code: "BASE_TYPE_CHOICES",
    message: "Value must be one of {60, 1440, 4320, 10080}.",
};

export interface CreateThreadOptions {
    parent: Channel;
    user_id: string;
    name: string;
    type: ChannelType;
    id?: string;
    auto_archive_duration?: number;
    rate_limit_per_user?: number;
    invitable?: boolean;
    applied_tags?: string[];
}

export async function createThread(opts: CreateThreadOptions) {
    const { parent, user_id, type } = opts;
    const name = opts.name?.trim();
    if (!name) throw new HTTPError("Thread name cannot be empty.", 400);
    if (opts.name.length > 100)
        throw FieldErrors({
            name: { code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." },
        });
    if (opts.auto_archive_duration != null && !AUTO_ARCHIVE_DURATIONS.includes(Number(opts.auto_archive_duration)))
        throw FieldErrors({ auto_archive_duration: AUTO_ARCHIVE_DURATION_ERROR });
    for (const character of InvisibleCharacters) if (name === character) throw new HTTPError("Thread name cannot include invalid characters", 400);

    if (parent.threadOnly()) {
        if (type !== ChannelType.GUILD_PUBLIC_THREAD) throw DiscordApiErrors.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE;
    } else if (parent.type === ChannelType.GUILD_NEWS) {
        if (type !== ChannelType.GUILD_NEWS_THREAD) throw DiscordApiErrors.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE;
    } else if (parent.type === ChannelType.GUILD_TEXT) {
        if (type !== ChannelType.GUILD_PUBLIC_THREAD && type !== ChannelType.GUILD_PRIVATE_THREAD) throw DiscordApiErrors.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE;
    } else throw DiscordApiErrors.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE;

    const now = new Date().toISOString();
    const auto_archive_duration = AUTO_ARCHIVE_DURATIONS.includes(Number(opts.auto_archive_duration))
        ? Number(opts.auto_archive_duration)
        : (parent.default_auto_archive_duration ?? (parent.threadOnly() ? 10080 : 4320));

    const thread = Channel.create({
        id: opts.id ?? Snowflake.generate(),
        created_at: new Date(),
        type,
        name,
        guild_id: parent.guild_id,
        parent_id: parent.id,
        owner_id: user_id,
        nsfw: parent.nsfw,
        flags: 0,
        permission_overwrites: [],
        rate_limit_per_user: (parent.threadOnly() ? undefined : opts.rate_limit_per_user) ?? parent.default_thread_rate_limit_per_user ?? 0,
        applied_tags: opts.applied_tags ?? [],
        member_count: 1,
        message_count: 0,
        total_message_sent: 0,
        thread_metadata: {
            archived: false,
            auto_archive_duration,
            archive_timestamp: now,
            create_timestamp: now,
            locked: false,
            ...(type === ChannelType.GUILD_PRIVATE_THREAD ? { invitable: opts.invitable ?? true } : {}),
        },
    });
    await thread.save();

    const guildMember = await Member.findOneOrFail({
        where: { id: user_id, guild_id: parent.guild_id! },
        select: { index: true, id: true },
    });
    const member = await ThreadMember.create({
        id: thread.id,
        user_id,
        member_idx: guildMember.index,
        join_timestamp: new Date(),
        muted: false,
        flags: ThreadMemberFlags.HAS_INTERACTED,
    }).save();

    if (parent.threadOnly()) {
        parent.last_message_id = thread.id;
        await Channel.update({ id: parent.id }, { last_message_id: thread.id });
    }

    const data = { ...thread.toJSON(), newly_created: true };
    const transaction_id = Snowflake.generate();
    await emitEvent({
        event: "THREAD_CREATE",
        data,
        ...(thread.isPrivateThread() ? { user_id } : { channel_id: parent.id }),
    } satisfies ThreadCreateEvent);
    const membersUpdate = {
        id: thread.id,
        guild_id: thread.guild_id!,
        member_count: 1,
        added_members: [member.toJSON()],
    };
    await Promise.all([
        emitEvent({
            event: "THREAD_MEMBERS_UPDATE",
            data: membersUpdate,
            user_id,
            transaction_id,
        } satisfies ThreadMembersUpdateEvent),
        emitEvent({
            event: "THREAD_MEMBERS_UPDATE",
            data: membersUpdate,
            channel_id: thread.id,
            transaction_id,
        } satisfies ThreadMembersUpdateEvent),
    ]);

    return { thread, member };
}

export async function emitThreadUpdate(thread: Channel) {
    await emitEvent({
        event: "THREAD_UPDATE",
        data: thread.toJSON(),
        ...(thread.isPrivateThread() ? { channel_id: thread.id } : { channel_id: thread.parent_id! }),
    } satisfies ThreadUpdatEvent);
}

export async function setThreadArchived(thread: Channel, archived: boolean) {
    if (!thread.thread_metadata) return;
    thread.thread_metadata = {
        ...thread.thread_metadata,
        archived,
        archive_timestamp: new Date().toISOString(),
    };
    if (archived) thread.flags &= ~Number(ChannelFlags.FLAGS.PINNED);
    await Channel.update({ id: thread.id }, { thread_metadata: thread.thread_metadata, flags: thread.flags });
}

export async function onThreadMessage(thread: Channel, user_id: string, mentioned_ids: string[] = []) {
    if (thread.thread_metadata?.archived) {
        await setThreadArchived(thread, false);
        await emitThreadUpdate(thread);
    }
    await ThreadMember.join(thread, user_id);

    const candidates = [...new Set(mentioned_ids)].filter((id) => id !== user_id);
    if (!candidates.length || !thread.guild_id || !thread.parent_id) return;
    if (thread.isPrivateThread() && !thread.thread_metadata?.invitable && thread.owner_id !== user_id) {
        if (!(await getPermission(user_id, thread.guild_id, thread.parent_id)).has("MANAGE_THREADS")) return;
    }
    const members = await Member.find({
        where: { guild_id: thread.guild_id, id: In(candidates) },
        select: { id: true },
    });
    for (const { id } of members) {
        const permission = await getPermission(id, thread.guild_id, thread.parent_id).catch(() => undefined);
        if (!permission?.has("VIEW_CHANNEL")) continue;
        await ThreadMember.join(thread, id, ThreadMemberFlags.NONE);
    }
}

let stopping = false;
let workerTimer: NodeJS.Timeout | undefined;
let archiving: Promise<void> | undefined;

export function archiveInactiveThreads() {
    if (stopping) return archiving ?? Promise.resolve();
    if (archiving) return archiving;
    archiving = archiveInactiveThreadsOnce().finally(() => {
        archiving = undefined;
    });
    return archiving;
}

async function archiveInactiveThreadsOnce() {
    const threads = await Channel.createQueryBuilder("channel")
        .where("channel.type IN (:...types)", { types: THREAD_TYPES })
        .andWhere(isSqlite() ? "channel.thread_metadata ->> 'archived' = 0" : "(channel.thread_metadata ->> 'archived')::boolean = false")
        .getMany();
    const now = Date.now();
    for (const thread of threads) {
        if (stopping) break;
        const meta = thread.thread_metadata!;
        if (thread.flags & Number(ChannelFlags.FLAGS.PINNED)) continue;
        const lastMessage = thread.last_message_id ? Snowflake.deconstruct(thread.last_message_id).timestamp : 0;
        const lastActivity = Math.max(lastMessage, new Date(meta.archive_timestamp).getTime(), new Date(meta.create_timestamp ?? 0).getTime());
        if (now - lastActivity < (meta.auto_archive_duration || 4320) * 60_000) continue;
        await setThreadArchived(thread, true);
        await emitThreadUpdate(thread);
    }
}

export function startThreadArchiver() {
    if (workerTimer || stopping) return workerTimer;
    const run = () => archiveInactiveThreads().catch((error) => console.error("[Threads] auto-archive failed", error));
    const initial = setTimeout(run, 10_000);
    workerTimer = setInterval(run, 60_000);
    ProcessLifecycle.eventEmitter.once("stopping", async () => {
        stopping = true;
        clearTimeout(initial);
        clearInterval(workerTimer);
        await Promise.allSettled(archiving ? [archiving] : []);
    });
    return workerTimer;
}

export async function threadSearchExtras(threads: Channel[], user_id: string) {
    const ids = threads.map((t) => t.id);
    if (!ids.length)
        return {
            members: [],
            first_messages: [],
            most_recent_messages: [],
            owners: new Map<string, unknown>(),
        };
    const guild_id = threads[0].guild_id!;
    const lastIds = threads.map((t) => t.last_message_id).filter((x): x is string => !!x && !ids.includes(x));
    const messageRelations = {
        author: true,
        attachments: true,
        sticker_items: true,
        mentions: true,
        mention_roles: true,
    } as const;
    const [members, firstMessages, recentMessages, owners] = await Promise.all([
        ThreadMember.find({ where: { id: In(ids), user_id } }),
        Message.find({ where: { id: In(ids) }, relations: messageRelations }),
        lastIds.length ? Message.find({ where: { id: In(lastIds) }, relations: messageRelations }) : Promise.resolve([] as Message[]),
        Member.find({
            where: {
                guild_id,
                id: In([...new Set(threads.map((t) => t.owner_id).filter((x): x is string => !!x))]),
            },
            relations: { user: true, roles: true },
        }),
    ]);
    return {
        members: members.map((m) => m.toJSON()),
        first_messages: firstMessages.map((m) => m.toPublicJSON(user_id)),
        most_recent_messages: recentMessages.map((m) => m.toPublicJSON(user_id)),
        owners: new Map(owners.map((o) => [o.id, { ...o.toPublicMember(), roles: o.roles.filter((r) => r.id !== guild_id).map((r) => r.id) }])),
    };
}
