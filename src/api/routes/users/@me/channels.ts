import { isSqlite } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { HTTPError } from "lambert-server/HTTPError";
import { Channel, Guild, Recipient, Relationship } from "@spacebar/database";
import { Config, DiscordApiErrors, DmChannelDTO, FieldErrors, getPermission } from "@spacebar/util";
import { ChannelType, DmChannelCreateSchema, RelationshipType } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "APIDMChannelArray",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const recipients = await Recipient.find({
            where: { user_id: req.user_id, closed: false },
            relations: { channel: { recipients: true } },
        });
        const userIds = [...new Set(recipients.flatMap((r) => r.channel.recipients?.map((x) => x.user_id) ?? []))].filter((id) => id !== req.user_id);
        const users = new Map((userIds.length ? await DmChannelDTO.users(userIds) : []).map((u) => [u.id, u]));
        res.json(
            await Promise.all(
                recipients.map(async (r) => ({
                    ...(await DmChannelDTO.from(r.channel, [req.user_id], undefined, users)),
                    is_spam: false,
                    is_message_request: !!r.message_request_timestamp,
                    is_message_request_timestamp: r.message_request_timestamp?.toISOString() ?? null,
                })),
            ),
        );
    },
);

router.post(
    "/",
    route({
        requestBody: "DmChannelCreateSchema",
        responses: {
            200: {
                body: "DmChannelDTO",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const body = req.body as DmChannelCreateSchema;
        const targets = body.recipients || (body.recipient_id ? [body.recipient_id] : []);
        // the creator is in the group too
        const maxOthers = Config.get().limits.channel.maxGroupDmRecipients - 1;
        if (new Set(targets.filter((id) => id !== req.user_id)).size > maxOthers)
            throw FieldErrors({
                recipients: {
                    code: "BASE_TYPE_MAX_LENGTH",
                    message: `Must be ${maxOthers} or fewer in length.`,
                },
            });
        // nobody can start a group with someone who blocked them or whom they blocked
        const others = [...new Set(targets.filter((id) => id !== req.user_id))];
        if (others.length > 1 && (await Relationship.blockedAmong(req.user_id, others)).size) throw DiscordApiErrors.CANNOT_MESSAGE_USER;
        const other = targets.length === 1 && targets[0] !== req.user_id ? targets[0] : null;
        if (other && !req.user_bot) {
            const [friends, existing, paused] = await Promise.all([
                Relationship.exists({
                    where: { from_id: req.user_id, to_id: other, type: RelationshipType.FRIEND },
                }),
                Recipient.query(
                    `SELECT 1 FROM recipients a INNER JOIN recipients b ON a.channel_id = b.channel_id INNER JOIN channels c ON c.id = a.channel_id WHERE a.user_id = $1 AND b.user_id = $2 AND c.type = $3 LIMIT 1`,
                    [req.user_id, other, ChannelType.DM],
                ),
                Guild.query(
                    `SELECT g.id FROM guilds g INNER JOIN members a ON a.guild_id = g.id AND a.id = $1 INNER JOIN members b ON b.guild_id = g.id AND b.id = $2 WHERE ${isSqlite() ? "datetime(g.incidents_data ->> 'dms_disabled_until') > datetime('now')" : "(g.incidents_data ->> 'dms_disabled_until')::timestamptz > now()"}`,
                    [req.user_id, other],
                ),
            ]);
            if (!friends && !existing.length)
                for (const { id } of paused as { id: string }[]) {
                    const permission = await getPermission(req.user_id, `${id}`);
                    if (!permission.has("KICK_MEMBERS") && !permission.has("BAN_MEMBERS") && !permission.has("MODERATE_MEMBERS") && !permission.has("MANAGE_GUILD"))
                        throw new HTTPError("Direct messages between members of this server are paused.", 403);
                }
        }
        res.json(await Channel.createDMChannel(body.recipients || (body.recipient_id ? [body.recipient_id] : []), req.user_id, body.name));
    },
);

export default router;
