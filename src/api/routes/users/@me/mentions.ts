import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { Message, Member, Channel, Attachment, MentionDismissal, ThreadMember } from "@spacebar/database";
import { Snowflake, Permissions, NewUrlUserSignatureData, FieldErrors, emitEvent, RecentMentionDeleteEvent, DiscordApiErrors } from "@spacebar/util";
import { ChannelType } from "@spacebar/schemas";
import { Stopwatch } from "@spacebar/extensions";

const router: Router = Router({ mergeParams: true });

router.get(
    "",
    route({
        responses: {
            200: {
                body: "MessageListResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    // AFAICT this endpoint doesn't list DMs
    async (req: Request, res: Response) => {
        const limit = req.query.limit !== undefined ? Number(req.query.limit) : 25;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw FieldErrors({
                limit: { code: "NUMBER_TYPE_MAX", message: "int value should be between 1 and 100." },
            });
        const everyone = `${req.query.everyone}` !== "false";
        const roles = `${req.query.roles}` !== "false";
        const before = req.query.before !== undefined ? String(req.query.before as string) : undefined;
        const guild_id = req.query.guild_id !== undefined ? req.query.guild_id : undefined;

        const user = req.user;

        const scope = guild_id === undefined || guild_id === "0" ? null : String(guild_id);
        const db = Message.getRepository();
        const [guildRows, roleRows] = await Promise.all([
            db.query(`SELECT guild_id FROM members WHERE id = $1 AND (CAST($2 AS bigint) IS NULL OR guild_id = $2)`, [req.user_id, scope]) as Promise<{ guild_id: string }[]>,
            (roles
                ? db.query(
                      `SELECT mr.role_id FROM members m JOIN member_roles mr ON mr."index" = m."index" JOIN roles r ON r.id = mr.role_id
                       WHERE m.id = $1 AND (CAST($2 AS bigint) IS NULL OR m.guild_id = $2) AND r.mentionable`,
                      [req.user_id, scope],
                  )
                : Promise.resolve([])) as Promise<{ role_id: string }[]>,
        ]);
        const guildIds = guildRows.map((row) => `${row.guild_id}`);
        const ownedMentionableRoleIds = roleRows.map((row) => `${row.role_id}`);
        const memberByGuild = new Map<string, Member>();
        const loadMembers = async (ids: string[]) => {
            const missing = [...new Set(ids)].filter((id) => !memberByGuild.has(id));
            if (!missing.length) return;
            const found = await Member.find({
                where: { id: req.user_id, guild_id: In(missing) },
                select: {
                    guild_id: true,
                    id: true,
                    communication_disabled_until: true,
                    roles: { id: true, position: true, permissions: true },
                    guild: { id: true, owner_id: true },
                },
                relations: { guild: true, roles: true },
            });
            for (const member of found) memberByGuild.set(member.guild_id, member);
        };
        const channels = new Map<string, Channel | null>();
        const joinedPrivateThreads = new Set<string>();
        const threadTypes = [ChannelType.GUILD_PUBLIC_THREAD, ChannelType.GUILD_PRIVATE_THREAD, ChannelType.GUILD_NEWS_THREAD];
        const loadChannels = async (channelIds: string[]) => {
            const missing = channelIds.filter((id) => !channels.has(id));
            if (!missing.length) return;
            const found = await Channel.find({
                where: { id: In(missing) },
                select: {
                    id: true,
                    guild_id: true,
                    permission_overwrites: true,
                    parent_id: true,
                    type: true,
                },
            });
            for (const id of missing) channels.set(id, null);
            for (const c of found) channels.set(c.id, c);
            const privateThreads = found.filter((c) => c.type === ChannelType.GUILD_PRIVATE_THREAD).map((c) => c.id);
            if (privateThreads.length)
                for (const m of await ThreadMember.find({
                    where: { id: In(privateThreads), user_id: req.user_id },
                    select: { id: true },
                }))
                    joinedPrivateThreads.add(m.id);
            await loadChannels(found.filter((c) => c.parent_id && threadTypes.includes(c.type)).map((c) => c.parent_id!));
        };
        const canView = (channelId: string) => {
            const c = channels.get(channelId);
            const member = c?.guild_id ? memberByGuild.get(c.guild_id) : undefined;
            if (!c || !member) return false;
            if (c.type === ChannelType.GUILD_PRIVATE_THREAD && !joinedPrivateThreads.has(c.id)) return false;
            const source = c.parent_id && threadTypes.includes(c.type) ? channels.get(c.parent_id) : c;
            return Permissions.finalPermission({
                user: {
                    id: member.id,
                    roles: member.roles.map((r) => r.id),
                    communication_disabled_until: member.communication_disabled_until,
                    flags: 0,
                },
                guild: { id: member.guild.id, owner_id: member.guild.owner_id!, roles: member.roles },
                channel: { overwrites: source?.permission_overwrites ?? [] },
            }).has("VIEW_CHANNEL");
        };

        const ids: string[] = [];
        const batch = Math.min(limit * 2, 200);
        let cursor = before ?? null;
        for (let round = 0; guildIds.length && ids.length < limit && round < 5; round++) {
            const rows: { id: string; channel_id: string }[] = await Message.getRepository().query(
                `SELECT id, channel_id FROM (
                    SELECT * FROM (SELECT m.id, m.channel_id FROM message_user_mentions u JOIN messages m ON m.id = u.message_id
                     WHERE u.user_id = $1 AND ${sqlArrayIncludes("m.guild_id", "$2")} AND (CAST($3 AS bigint) IS NULL OR u.message_id < $3) AND m.author_id IS DISTINCT FROM $1 ORDER BY u.message_id DESC LIMIT $4) user_mentions
                    UNION
                    SELECT * FROM (SELECT id, channel_id FROM messages WHERE $5 AND mention_everyone AND ${sqlArrayIncludes("guild_id", "$2")} AND (CAST($3 AS bigint) IS NULL OR id < $3) AND author_id IS DISTINCT FROM $1 ORDER BY id DESC LIMIT $4) everyone_mentions
                    UNION
                    SELECT * FROM (SELECT m.id, m.channel_id FROM message_role_mentions r JOIN messages m ON m.id = r.message_id
                     WHERE $6 AND ${sqlArrayIncludes("r.role_id", "$7")} AND ${sqlArrayIncludes("m.guild_id", "$2")} AND (CAST($3 AS bigint) IS NULL OR r.message_id < $3) AND m.author_id IS DISTINCT FROM $1 ORDER BY r.message_id DESC LIMIT $4) role_mentions
                ) mentioned WHERE NOT EXISTS (SELECT 1 FROM mention_dismissals d WHERE d.user_id = $1 AND d.message_id = mentioned.id) ORDER BY id DESC LIMIT $4`,
                [user.id, guildIds, cursor, batch, everyone, roles, ownedMentionableRoleIds],
            );
            await loadChannels([...new Set(rows.map((row) => `${row.channel_id}`))]);
            await loadMembers(rows.map((row) => channels.get(`${row.channel_id}`)?.guild_id).filter((id): id is string => !!id));
            for (const row of rows) if (ids.length < limit && canView(`${row.channel_id}`)) ids.push(`${row.id}`);
            if (rows.length < batch) break;
            cursor = `${rows[rows.length - 1].id}`;
        }
        if (!ids.length) return res.json([]);

        const sw = Stopwatch.startNew();
        const finalMessages = (
            await Message.find({
                where: { id: In(ids) },
                order: { id: "DESC" },
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
                    referenced_message: {
                        author: true,
                        webhook: true,
                        application: true,
                        mentions: true,
                        mention_roles: true,
                        mention_channels: true,
                        sticker_items: true,
                        attachments: true,
                    },
                },
            })
        ).map((m) => ({
            ...m.toJSON(),
            attachments: m.attachments?.map((attachment: Attachment) =>
                Attachment.prototype.signUrls.call(
                    attachment,
                    new NewUrlUserSignatureData({
                        ip: req.ip,
                        userAgent: req.headers["user-agent"] as string,
                    }),
                ),
            ),
        }));

        console.log(`[Inbox/mentions] User ${user.id} fetched full message data for ${finalMessages.length} messages in ${sw.elapsed().totalMilliseconds}ms`);

        return res.json(finalMessages);
    },
);

router.delete(
    "/:message_id",
    route({
        responses: {
            204: {},
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const message_id = req.params.message_id as string;
        if (!(await Message.existsBy({ id: message_id }))) throw DiscordApiErrors.UNKNOWN_MESSAGE;
        await MentionDismissal.createQueryBuilder().insert().values({ user_id: req.user_id, message_id }).orIgnore().execute();
        await emitEvent({
            event: "RECENT_MENTION_DELETE",
            user_id: req.user_id,
            data: { message_id },
        } satisfies RecentMentionDeleteEvent);
        return res.sendStatus(204);
    },
);

export default router;
