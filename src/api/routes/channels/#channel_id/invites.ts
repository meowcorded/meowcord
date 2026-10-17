import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Channel, Invite, PublicInviteRelation, Recipient } from "@spacebar/database";
import { DiscordApiErrors, InviteCreateEvent, emitEvent } from "@spacebar/util";
import { AuditLogEvents, ChannelType, InviteCreateSchema } from "@spacebar/schemas";
import { Random } from "@spacebar/extensions";
import { InviteListResponse } from "@spacebar/schemas/api/guilds/Invite";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        requestBody: "InviteCreateSchema",
        permission: "CREATE_INSTANT_INVITE",
        right: "CREATE_INVITES",
        responses: {
            201: {
                body: "Invite",
            },
            404: {},
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { user_id } = req;
        const body = req.body as InviteCreateSchema;
        const { channel_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
            select: { id: true, name: true, type: true, guild_id: true },
        });
        if (channel.type === ChannelType.GUILD_CATEGORY || channel.isThread() || channel.type === ChannelType.DM) throw DiscordApiErrors.CANNOT_EXECUTE_ON_THIS_CHANNEL_TYPE;

        if (channel.type === ChannelType.GROUP_DM) {
            if (!(await Recipient.exists({ where: { channel_id, user_id } }))) throw DiscordApiErrors.UNKNOWN_CHANNEL;
            const max_age = Math.min(604800, Math.max(1, body.max_age ?? 86400));
            const invite = await Invite.create({
                code: Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 8),
                temporary: false,
                uses: 0,
                max_uses: 0,
                max_age,
                expires_at: new Date(max_age * 1000 + Date.now()),
                created_at: new Date(),
                channel_id,
                inviter_id: user_id,
                flags: 0,
            }).save();
            const created = await Invite.findOneOrFail({
                where: { code: invite.code },
                relations: { inviter: true, channel: true },
            });
            await created.loadGroupRecipients();
            return res.status(201).send(created.toMetadataJSON());
        }

        if (!channel.guild_id) {
            throw new HTTPError("This channel doesn't exist", 404);
        }
        const { guild_id } = channel;
        if ((body.flags ?? 0) & 8) req.permission?.hasThrow("KICK_MEMBERS");

        const max_age = Math.max(0, body.max_age ?? 86400);
        const expires_at = max_age == 0 ? undefined : new Date(max_age * 1000 + Date.now());

        const invite = await Invite.create({
            code: Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 6),
            temporary: body.temporary ?? false,
            uses: 0,
            max_uses: body.max_uses ? Math.max(0, body.max_uses) : 0,
            max_age,
            expires_at,
            created_at: new Date(),
            guild_id,
            channel_id: channel_id,
            inviter_id: user_id,
            flags: body.flags ?? 0,
        }).save();

        const data = (
            await Invite.findOneOrFail({
                where: { code: invite.code },
                relations: Object.fromEntries(PublicInviteRelation.map((i) => [i, true])),
            })
        ).toMetadataJSON();

        await AuditLog.log({
            guild_id,
            user_id,
            action_type: AuditLogEvents.INVITE_CREATE,
            target_id: null,
            changes: AuditLog.diff({}, { ...data, inviter_id: user_id, channel_id }, ["code", "channel_id", "inviter_id", "uses", "max_uses", "max_age", "temporary", "flags"]),
            reason: req.headers["x-audit-log-reason"],
        });
        await emitEvent({
            event: "INVITE_CREATE",
            data: { ...data, channel_id } as unknown as InviteCreateEvent["data"],
            guild_id,
        } satisfies InviteCreateEvent);

        res.status(201).send(data);
    },
);

router.get(
    "/",
    route({
        permission: "MANAGE_CHANNELS",
        responses: {
            200: {
                body: "InviteListResponse",
            },
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
        });

        if (channel.type === ChannelType.GROUP_DM) {
            const invites = await Invite.find({
                where: { channel_id },
                relations: { inviter: true, channel: true },
            });
            const live = invites.filter((x) => !x.isExpired());
            await Promise.all(live.map((x) => x.loadGroupRecipients()));
            return res.status(200).send(live.map((x) => x.toMetadataJSON()) satisfies InviteListResponse);
        }

        if (!channel.guild_id) {
            throw new HTTPError("This channel doesn't exist", 404);
        }
        const { guild_id } = channel;

        const invites = (
            await Invite.find({
                where: { guild_id, channel_id },
                relations: Object.fromEntries(PublicInviteRelation.map((i) => [i, true])), //TODO: cleanup
            })
        ).map((x) => x.toMetadataJSON());

        res.status(200).send(invites satisfies InviteListResponse);
    },
);

export default router;
