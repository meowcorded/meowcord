import { sqlArrayAggregate, sqlArrayIncludes } from "@spacebar/database/Sql";
import { In } from "typeorm";
import { Channel, Guild, Member, PushDevice, Role, ThreadMember, ThreadMemberFlags, WebPushKeys } from "@spacebar/database";
import { Config, MessageFlags, Permissions, PRESENCE_STALE_AFTER_MS } from "@spacebar/util";
import { ChannelOverride, ChannelType, DefaultUserGuildSettings, MuteConfig, RelationshipType, UserGuildSettings } from "@spacebar/schemas";
import { sendWebPush, vapidPublicKey } from "./webPush";

export interface AudienceMember {
    id: string;
    roles: string[];
    settings: Partial<UserGuildSettings> | null;
}

export interface MentionTarget {
    channel: Channel;
    author_id?: string;
    user_ids: string[];
    role_ids: string[];
    everyone: boolean;
    here: boolean;
}

export const loadAudienceMembers = (guild_id: string, filter: { all: boolean; ids: string[]; roles: string[] }): Promise<AudienceMember[]> =>
    Member.query(
        `SELECT CAST(m.id AS text) AS id, m.settings, ${sqlArrayAggregate("CAST(mr.role_id AS text)", "mr.role_id IS NOT NULL")} AS roles
         FROM members m LEFT JOIN member_roles mr ON mr."index" = m."index"
         WHERE m.guild_id = $1 AND (CAST($2 AS boolean) OR ${sqlArrayIncludes("m.id", "$3")} OR m."index" IN (SELECT "index" FROM member_roles WHERE ${sqlArrayIncludes("role_id", "$4")}))
         GROUP BY m."index"`,
        [guild_id, filter.all, filter.ids, filter.roles],
    );

export async function channelViewChecker(channel: Channel) {
    const guild_id = channel.guild_id!;
    const [guild, roles, source] = await Promise.all([
        Guild.findOne({ where: { id: guild_id }, select: { id: true, owner_id: true } }),
        Role.find({ where: { guild_id }, select: { id: true, permissions: true } }),
        channel.isThread() && channel.parent_id
            ? Channel.findOne({
                  where: { id: channel.parent_id },
                  select: { id: true, permission_overwrites: true },
              })
            : channel,
    ]);
    return (member: AudienceMember) =>
        Permissions.finalPermission({
            user: {
                id: member.id,
                roles: [guild_id, ...member.roles],
                communication_disabled_until: null,
                flags: 0,
            },
            guild: { id: guild_id, owner_id: guild?.owner_id ?? "", roles },
            channel: { overwrites: source?.permission_overwrites ?? [] },
        }).has("VIEW_CHANNEL");
}

export async function usersBlocking(author_id: string | undefined, ids: string[]) {
    if (!author_id || !ids.length) return new Set<string>();
    const rows: { id: string }[] = await Member.query(
        `SELECT CAST(from_id AS text) AS id FROM relationships WHERE to_id = $1 AND (type = $2 OR user_ignored) AND ${sqlArrayIncludes("from_id", "$3")}`,
        [author_id, RelationshipType.BLOCKED, ids],
    );
    return new Set(rows.map((r) => r.id));
}

export async function onlineUsers(ids: string[]) {
    if (!ids.length) return new Set<string>();
    const rows: { user_id: string }[] = await Member.query(
        `SELECT DISTINCT CAST(user_id AS text) AS user_id FROM sessions WHERE ${sqlArrayIncludes("user_id", "$1")} AND status <> 'offline' AND NOT is_admin_session AND last_seen > $2`,
        [ids, new Date(Date.now() - PRESENCE_STALE_AFTER_MS)],
    );
    return new Set(rows.map((r) => r.user_id));
}

export async function threadMemberIds(thread_id: string) {
    return new Set((await ThreadMember.find({ where: { id: thread_id }, select: { user_id: true } })).map((m) => m.user_id));
}

export async function getMentionedUsers(target: MentionTarget) {
    const { channel, author_id } = target;
    if (channel.isDm()) {
        const ids = (channel.recipients ?? []).map((r) => r.user_id).filter((id) => id !== author_id);
        const blocked = await usersBlocking(author_id, ids);
        return new Set(ids.filter((id) => !blocked.has(id)));
    }

    const broad = target.everyone || target.here;
    if (!channel.guild_id || (!broad && !target.user_ids.length && !target.role_ids.length)) return new Set<string>();

    const threadMembers = channel.isThread() ? await threadMemberIds(channel.id) : null;
    const members = await loadAudienceMembers(channel.guild_id, {
        all: broad && !threadMembers,
        ids: [...target.user_ids, ...(broad && threadMembers ? threadMembers : [])],
        roles: target.role_ids,
    });
    const online = target.here ? await onlineUsers(members.map((m) => m.id)) : new Set<string>();
    const canView = await channelViewChecker(channel);

    const mentioned = members
        .filter((member) => {
            if (member.id === author_id) return false;
            const direct = target.user_ids.includes(member.id);
            if (channel.isPrivateThread() && !direct && !threadMembers?.has(member.id)) return false;
            const role = !member.settings?.suppress_roles && member.roles.some((id) => target.role_ids.includes(id));
            const everyone = !member.settings?.suppress_everyone && (!threadMembers || threadMembers.has(member.id)) && (target.everyone || (target.here && online.has(member.id)));
            return (direct || role || everyone) && canView(member);
        })
        .map((member) => member.id);
    const blocked = await usersBlocking(author_id, mentioned);
    return new Set(mentioned.filter((id) => !blocked.has(id)));
}

interface PushMessage {
    id: string;
    channel_id: string;
    guild_id?: string | null;
    author?: { id: string; username: string; global_name?: string | null; avatar?: string | null };
    member?: { nick?: string | null } | null;
    content?: string;
    flags?: number | string;
    mentions?: { id: string; username: string; global_name?: string | null }[];
    mention_roles?: string[];
    mention_everyone?: boolean;
    attachments?: unknown[];
    embeds?: unknown[];
    sticker_items?: { name: string }[];
}

interface PushDeviceRow {
    id: string;
    user_id: string;
    token: string;
    keys: WebPushKeys | null;
}

const ALL_MESSAGES = 0;
const NO_MESSAGES = 2;
const INHERIT = 3;
const SILENT = Number(MessageFlags.FLAGS.SUPPRESS_NOTIFICATIONS | MessageFlags.FLAGS.EPHEMERAL);

const isMuted = (
    target?: {
        muted?: boolean;
        mute_config?: MuteConfig | { end_time?: string | Date | null } | null;
    } | null,
) => !!target?.muted && (!target.mute_config?.end_time || new Date(target.mute_config.end_time).getTime() > Date.now());

async function dndUsers(ids: string[]) {
    const rows: { id: string }[] = await Member.query(
        `SELECT CAST(u.id AS text) AS id FROM users u JOIN user_settings s ON s."index" = u."settingsIndex" WHERE ${sqlArrayIncludes("u.id", "$1")} AND s.status = 'dnd'`,
        [ids],
    );
    return new Set(rows.map((r) => r.id));
}

async function pushRecipients(channel: Channel, message: PushMessage, candidates: string[]) {
    const author_id = message.author?.id;
    const user_ids = (message.mentions ?? []).map((user) => user.id);
    const role_ids = message.mention_roles ?? [];
    const everyone = !!message.mention_everyone && /@everyone/.test(message.content ?? "");
    const blocked = await usersBlocking(author_id, candidates);
    const allowed = candidates.filter((id) => id !== author_id && !blocked.has(id));

    if (channel.isDm()) {
        const open = new Set((channel.recipients ?? []).filter((r) => !r.message_request_timestamp).map((r) => r.user_id));
        const rows: { id: string; settings: UserGuildSettings | null }[] = await Member.query(
            `SELECT CAST(id AS text) AS id, private_channel_settings AS settings FROM users WHERE ${sqlArrayIncludes("id", "$1")}`,
            [allowed],
        );
        return new Set(
            rows
                .filter((row) => {
                    if (!open.has(row.id)) return false;
                    const settings = { ...DefaultUserGuildSettings, ...(row.settings ?? {}) };
                    return settings.mobile_push !== false && (!isMuted(settings.channel_overrides?.[channel.id]) || user_ids.includes(row.id));
                })
                .map((row) => row.id),
        );
    }

    const guild_id = channel.guild_id!;
    const thread = channel.isThread() ? channel : null;
    const [members, canView, guild, parent, threadMembers] = await Promise.all([
        loadAudienceMembers(guild_id, { all: false, ids: allowed, roles: [] }),
        channelViewChecker(channel),
        Guild.findOne({
            where: { id: guild_id },
            select: { id: true, default_message_notifications: true },
        }),
        thread?.parent_id ? Channel.findOne({ where: { id: thread.parent_id }, select: { id: true, parent_id: true } }) : channel,
        thread ? ThreadMember.find({ where: { id: thread.id, user_id: In(allowed) } }) : [],
    ]);
    const threadMember = new Map(threadMembers.map((m) => [m.user_id, m]));

    return new Set(
        members
            .filter((member) => {
                if (!canView(member)) return false;
                const membership = threadMember.get(member.id);
                if (thread && !membership) return false;

                const settings = { ...DefaultUserGuildSettings, ...(member.settings ?? {}) };
                if (settings.mobile_push === false) return false;
                const mentioned =
                    user_ids.includes(member.id) ||
                    ((!!thread || !settings.suppress_roles) && member.roles.some((id) => role_ids.includes(id))) ||
                    ((!!thread || !settings.suppress_everyone) && everyone);

                const overrides: Record<string, ChannelOverride> = settings.channel_overrides ?? {};
                const own = parent ? overrides[parent.id] : undefined;
                const category = parent?.parent_id ? overrides[parent.parent_id] : undefined;
                const muted = isMuted(settings) || isMuted(own) || isMuted(category);
                const level =
                    [own?.message_notifications, category?.message_notifications, settings.message_notifications].find((x) => x != null && x !== INHERIT) ??
                    guild?.default_message_notifications ??
                    1;

                if (membership) {
                    if (isMuted(membership) || membership.flags & ThreadMemberFlags.NO_MESSAGES) return false;
                    if (membership.flags & ThreadMemberFlags.ALL_MESSAGES) return true;
                    if (membership.flags & ThreadMemberFlags.ONLY_MENTIONS) return mentioned;
                    if (muted) return false;
                }
                if (level === NO_MESSAGES) return false;
                return (level === ALL_MESSAGES && !muted) || mentioned;
            })
            .map((member) => member.id),
    );
}

async function pushPayload(channel: Channel, message: PushMessage) {
    const author = message.author;
    const name = message.member?.nick || author?.global_name || author?.username || "Someone";
    const roles = message.mention_roles?.length
        ? await Role.find({
              where: { id: In(message.mention_roles) },
              select: { id: true, name: true },
          })
        : [];
    const content = (message.content ?? "")
        .replace(/<@!?(\d+)>/g, (match, id) => {
            const user = message.mentions?.find((u) => u.id === id);
            return user ? `@${user.global_name || user.username}` : match;
        })
        .replace(/<@&(\d+)>/g, (match, id) => {
            const role = roles.find((r) => r.id === id);
            return role ? `@${role.name}` : match;
        })
        .replace(/<a?(:\w+:)\d+>/g, "$1")
        .trim();
    const fallback = message.attachments?.length
        ? "Sent an attachment"
        : message.sticker_items?.length
          ? `Sent a sticker: ${message.sticker_items[0].name}`
          : message.embeds?.length
            ? "Sent an embed"
            : "";
    const body = content || fallback;
    const guild = channel.guild_id ? await Guild.findOne({ where: { id: channel.guild_id }, select: { id: true, name: true } }) : null;
    const where = channel.isDm() ? (channel.type === ChannelType.GROUP_DM ? channel.name || "Group DM" : null) : `#${channel.name}${guild ? `, ${guild.name}` : ""}`;
    const cdn = Config.get().cdn.endpointPublic || Config.get().api.endpointPublic || "http://localhost/";
    const avatar = author?.avatar ? `avatars/${author.id}/${author.avatar}.png?size=128` : `embed/avatars/${author ? Number((BigInt(author.id) >> 22n) % 6n) : 0}.png`;
    return {
        title: where ? `${name} (${where})` : name,
        body: body.length > 300 ? `${body.slice(0, 299)}…` : body,
        icon: new URL(avatar, cdn.endsWith("/") ? cdn : `${cdn}/`).toString(),
        tag: message.channel_id,
        url: `/channels/${channel.guild_id ?? "@me"}/${message.channel_id}/${message.id}`,
        channel_id: message.channel_id,
        guild_id: channel.guild_id ?? null,
        message_id: message.id,
    };
}

export async function dispatchMessagePush(message: PushMessage) {
    if (!vapidPublicKey() || !message?.channel_id || Number(message.flags ?? 0) & SILENT) return;
    const author_id = message.author?.id ?? null;
    const audience = message.guild_id ? `SELECT id FROM members WHERE guild_id = $2` : `SELECT user_id FROM recipients WHERE channel_id = $2`;
    const devices: PushDeviceRow[] = await PushDevice.query(
        `SELECT CAST(d.id AS text) AS id, CAST(d.user_id AS text) AS user_id, d.token, d.keys FROM push_devices d WHERE d.provider = 'webpush' AND d.user_id IS DISTINCT FROM CAST($1 AS bigint) AND d.user_id IN (${audience})`,
        [author_id, message.guild_id ?? message.channel_id],
    );
    if (!devices.length) return;

    const candidates = [...new Set(devices.map((d) => d.user_id))];
    const [online, dnd] = await Promise.all([onlineUsers(candidates), dndUsers(candidates)]);
    const offline = candidates.filter((id) => !online.has(id) && !dnd.has(id));
    if (!offline.length) return;

    const channel = await Channel.findOne({
        where: { id: message.channel_id },
        relations: { recipients: true },
    });
    if (!channel) return;
    const recipients = await pushRecipients(channel, message, offline);
    if (!recipients.size) return;

    const payload = await pushPayload(channel, message);
    await Promise.all(
        devices
            .filter((device) => recipients.has(device.user_id) && device.keys)
            .map(async (device) => {
                try {
                    const { gone } = await sendWebPush({ endpoint: device.token, keys: device.keys! }, payload);
                    if (gone) await PushDevice.delete({ id: device.id });
                } catch (e) {
                    console.warn(`[WebPush] delivery to device ${device.id} failed:`, (e as Error).message);
                }
            }),
    );
}
