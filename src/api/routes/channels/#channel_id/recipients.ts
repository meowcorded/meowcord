import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { checkContactSpam, e2eeDevicesOf, E2eeErrors, enforceQuarantineDm } from "@spacebar/api/util";
import { Channel, Recipient, Relationship, User } from "@spacebar/database";
import { ChannelDeleteEvent, ChannelRecipientAddEvent, ChannelUpdateEvent, Config, DiscordApiErrors, DmChannelDTO, emitEvent } from "@spacebar/util";
import { ChannelType, MessageType, PublicUserProjection } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

const ConsentStatus = { UNSPECIFIED: 0, PENDING: 1, ACCEPTED: 2, REJECTED: 3 };

const ownRecipient = async (channel_id: string, user_id: string) => {
    const channel = await Channel.findOneOrFail({
        where: { id: channel_id },
        relations: { recipients: true },
    });
    const recipient = channel.recipients?.find((r) => r.user_id === user_id);
    if (!recipient) throw DiscordApiErrors.UNKNOWN_CHANNEL;
    return { channel, recipient };
};

const requestState = (recipient: Recipient) => ({
    is_message_request: !!recipient.message_request_timestamp,
    is_message_request_timestamp: recipient.message_request_timestamp?.toISOString() ?? null,
    is_spam: false,
});

router.put(
    "/@me",
    route({
        responses: {
            204: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const { channel, recipient } = await ownRecipient(channel_id, req.user_id);
        const consent = Number(req.body?.consent_status ?? ConsentStatus.ACCEPTED);

        if (consent === ConsentStatus.ACCEPTED || consent === ConsentStatus.UNSPECIFIED) recipient.message_request_timestamp = null;
        else if (consent === ConsentStatus.PENDING) recipient.message_request_timestamp ??= new Date();
        recipient.closed = false;
        await recipient.save();

        await emitEvent({
            event: "CHANNEL_UPDATE",
            data: { ...(await DmChannelDTO.from(channel, [req.user_id])), ...requestState(recipient) },
            user_id: req.user_id,
        } as ChannelUpdateEvent);

        return res.sendStatus(204);
    },
);

router.delete(
    "/@me",
    route({
        responses: {
            204: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id } = req.params as { [key: string]: string };
        const { channel, recipient } = await ownRecipient(channel_id, req.user_id);

        if (channel.type === ChannelType.GROUP_DM) {
            await Channel.removeRecipientFromChannel(channel, req.user_id);
            return res.sendStatus(204);
        }

        recipient.closed = true;
        recipient.message_request_timestamp = null;
        await recipient.save();
        await emitEvent({
            event: "CHANNEL_DELETE",
            data: await DmChannelDTO.from(channel, [req.user_id]),
            user_id: req.user_id,
        } as ChannelDeleteEvent);

        return res.sendStatus(204);
    },
);

router.put(
    "/:user_id",
    route({
        responses: {
            201: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id, user_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
            relations: { recipients: true },
        });

        if (!channel.recipients || channel.recipients.length == 0 || channel.recipients.filter((r) => r.user_id == req.user_id).length == 0) {
            throw DiscordApiErrors.UNKNOWN_CHANNEL; // TODO: is this the right error
        }

        const added = await User.findOne({ where: { id: user_id }, select: { id: true, federated_instance: true } });
        if (added?.federated_instance && (channel.e2ee_enabled_at || channel.type !== ChannelType.GROUP_DM)) {
            const devices = await e2eeDevicesOf([user_id], { channel_id, force: true });
            if (!devices.some((device) => device.status === "active"))
                return res.status(400).json({ code: E2eeErrors.RECIPIENT_NO_DEVICES.code, message: E2eeErrors.RECIPIENT_NO_DEVICES.message, user_ids: [user_id] });
        }

        const members = channel.recipients?.map((r) => r.user_id) ?? [];
        if (channel.type === ChannelType.GROUP_DM && members.includes(user_id)) throw DiscordApiErrors.INVALID_RECIPIENT;
        const others = members.filter((id) => id !== user_id);
        const blocked = await Relationship.blockedAmong(user_id, others);
        if (blocked.size) throw DiscordApiErrors.CANNOT_MESSAGE_USER;
        const { maxGroupDmRecipients, maxStaffGroupDmRecipients } = Config.get().limits.channel;
        const limit = req.rights?.has("BYPASS_RATE_LIMITS") ? Math.max(maxGroupDmRecipients, maxStaffGroupDmRecipients ?? 0) : maxGroupDmRecipients;
        const recipients = [...new Set([...members, user_id])];
        if (recipients.length > limit) throw DiscordApiErrors.MAXIMUM_NUMBER_OF_RECIPIENTS_REACHED.withParams(String(limit));
        if (!req.user_bot && user_id !== req.user_id) {
            await checkContactSpam({ user_id: req.user_id, target_id: user_id, kind: "dm", rights: req.rights, federated: !!req.user?.federated_instance, account: req.user });
            await enforceQuarantineDm({ user_id: req.user_id, federated: !!req.user?.federated_instance, rights: req.rights });
        }

        if (channel.type !== ChannelType.GROUP_DM) {
            const new_channel = await Channel.createDMChannel(recipients, req.user_id);
            return res.status(201).json(new_channel);
        } else {
            channel.recipients?.push(Recipient.create({ channel_id: channel_id, user_id: user_id }));
            await channel.save();

            await emitEvent({
                event: "CHANNEL_CREATE",
                data: await DmChannelDTO.from(channel, [user_id]),
                user_id: user_id,
            });

            await emitEvent({
                event: "CHANNEL_RECIPIENT_ADD",
                data: {
                    channel_id: channel_id,
                    user: (
                        await User.findOneOrFail({
                            where: { id: user_id },
                            select: Object.fromEntries(PublicUserProjection.map((i) => [i, true])), //TODO: cleanup
                        })
                    ).toPublicUser(),
                },
                channel_id: channel_id,
            } satisfies ChannelRecipientAddEvent);
            await Channel.sendSystemMessage(channel, req.user_id, MessageType.RECIPIENT_ADD, {
                mention_ids: [user_id],
            });
            return res.sendStatus(204);
        }
    },
);

router.delete(
    "/:user_id",
    route({
        responses: {
            204: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id, user_id } = req.params as { [key: string]: string };
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
            relations: { recipients: true },
        });
        if (!(channel.type === ChannelType.GROUP_DM && (channel.owner_id === req.user_id || user_id === req.user_id))) throw DiscordApiErrors.MISSING_PERMISSIONS;

        if (!channel.recipients?.map((r) => r.user_id).includes(user_id)) {
            throw DiscordApiErrors.INVALID_RECIPIENT; //TODO is this the right error?
        }

        await Channel.removeRecipientFromChannel(channel, user_id, req.user_id);

        return res.sendStatus(204);
    },
);

export default router;
