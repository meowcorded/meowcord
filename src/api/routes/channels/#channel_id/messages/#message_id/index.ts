import { noteRightsBypass, permitted, scheduleSavedPoll } from "@spacebar/api/util";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import multer from "multer";
import { assertNoHarmfulLinks, checkAutomod, checkSpam, enforceQuarantine, handleMessage, postHandleMessage, syncCrosspostCopies } from "@spacebar/api/util";
import { route, parsePayloadJson } from "@spacebar/api/middlewares";
import { relayedAuthorship } from "@spacebar/api/util/utility/federationAuthorship";
import { Attachment, AuditLog, Channel, Message } from "@spacebar/database";
import {
    MessageCreateEvent,
    MessageDeleteEvent,
    MessageUpdateEvent,
    Snowflake,
    SpacebarApiErrors,
    emitEvent,
    getPermission,
    getRights,
    uploadFile,
    NewUrlUserSignatureData,
    DiscordApiErrors,
    FieldErrors,
    MessageFlags,
} from "@spacebar/util";
import { MessageCreateAttachment, MessageCreateCloudAttachment, MessageCreateSchema, MessageEditSchema, ChannelType, EmbedType, MessageType } from "@spacebar/schemas";

import { COMPONENTS_V2, componentMessageErrors } from "@spacebar/api/util/handlers/ComponentValidation";

const router = Router({ mergeParams: true });
// TODO: message content/embed string length limit

const messageUpload = multer({
    limits: {
        fileSize: 1024 * 1024 * 100,
        fields: 10,
        files: 1,
    },
    storage: multer.memoryStorage(),
}); // max upload 50 mb

router.patch(
    "/",
    route({
        requestBody: "MessageEditSchema",
        permission: "SEND_MESSAGES",
        right: "SEND_MESSAGES",
        responses: {
            200: {
                body: "PublicMessage",
            },
            400: {
                body: "APIErrorResponse",
            },
            403: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { message_id, channel_id } = req.params as { [key: string]: string };
        let body = req.body as MessageEditSchema;
        if (body.components?.length && !req.user_bot)
            throw FieldErrors({
                components: {
                    code: "COMPONENT_VALIDATION_FAILED",
                    message: "Only applications can send message components",
                },
            });

        const message = await Message.findOneOrFail({
            where: { id: message_id, channel_id },
            relations: {
                attachments: true,
                author: true,
                mentions: true,
                mention_roles: true,
                sticker_items: true,
            },
        });

        const permissions = await getPermission(req.user_id, undefined, channel_id);

        const rights = await getRights(req.user_id);

        if (req.user_id !== message.author_id) {
            if (!rights.has("MANAGE_MESSAGES")) {
                permissions.hasThrow("MANAGE_MESSAGES");
                body = { flags: body.flags };
                // guild admins can only suppress embeds of other messages, no such restriction imposed to instance-wide admins
            } else if (!permissions.has("MANAGE_MESSAGES")) await noteRightsBypass(req, "MANAGE_MESSAGES", message.author_id);
        } else rights.hasThrow("SELF_EDIT_MESSAGES");

        const componentErrors = componentMessageErrors({ ...message, ...body }, message.flags);
        if (Object.keys(componentErrors).length) throw FieldErrors(componentErrors);
        const suppress = Number(MessageFlags.FLAGS.SUPPRESS_EMBEDS);
        const editable = suppress | (req.user_bot && req.user_id === message.author_id ? COMPONENTS_V2 : 0);
        const flags = body.flags === undefined || body.flags === null ? message.flags : (message.flags & ~editable) | (body.flags & editable) | (message.flags & COMPONENTS_V2);

        if (Object.keys(body).every((key) => key === "flags")) {
            const unsuppressed = (message.flags & suppress) !== 0 && (flags & suppress) === 0;
            message.flags = flags;
            if (flags & suppress) message.embeds = message.embeds.filter((embed) => embed.type === EmbedType.rich);
            await Message.update({ id: message.id, channel_id }, { flags: message.flags, embeds: message.embeds });
            await emitEvent({
                event: "MESSAGE_UPDATE",
                channel_id,
                data: { ...message.toJSON(), nonce: undefined },
            } satisfies MessageUpdateEvent);
            if (unsuppressed) postHandleMessage(message).catch((e) => console.error("[Message] post-message handler failed", e));
            return res.json(message.toPublicJSON(req.user_id));
        }

        if (message.poll) {
            throw DiscordApiErrors.POLL_CANNOT_EDIT_MESSAGE;
        }

        if (body.content !== undefined && body.content !== message.content) {
            assertNoHarmfulLinks(body.content ?? "");
            if (message.author_id === req.user_id)
                await enforceQuarantine(
                    { user_id: req.user_id, federated: !!req.user?.federated_instance, bot: req.user_bot, system: req.user?.system, rights: req.rights },
                    { content: body.content ?? "", guild_id: message.guild_id, channel_id },
                );
            if (message.author_id === req.user_id)
                await checkSpam({
                    user_id: req.user_id,
                    channel: { id: channel_id, guild_id: message.guild_id },
                    content: body.content ?? "",
                    message_id: message.id,
                    permission: permissions,
                    rights: req.rights,
                    bot: req.user_bot,
                    system: req.user?.system,
                    account: req.user,
                    edit: true,
                    encrypted: !!body.encrypted,
                });
        }
        if (message.guild_id && body.content !== undefined && body.content !== message.content) {
            const channel = await Channel.findOneOrFail({ where: { id: channel_id } });
            await checkAutomod({
                guild_id: message.guild_id,
                channel,
                user_id: req.user_id,
                content: body.content ?? "",
                permission: permissions,
                message_id: message.id,
            });
        }

        const attachments = body.attachments?.map((attachment) =>
            "uploaded_filename" in attachment ? attachment : (message.attachments?.find((existing) => existing.id === attachment.id) ?? attachment),
        );

        const new_message = await handleMessage(
            {
                ...message,
                ...body,
                message_reference: message.message_reference,
                content: body.content === undefined ? message.content : (body.content ?? ""),
                flags,
                attachments: attachments ?? message.attachments,
                sticker_ids: message.sticker_items?.map((sticker) => sticker.id),
                author_id: message.author_id,
                channel_id,
                id: message_id,
                edited_timestamp: body.content !== undefined && body.content !== message.content ? new Date() : (message.edited_timestamp ?? new Date()),
            },
            { componentsChanged: body.components !== undefined },
        );
        if (new_message.flags & suppress) new_message.embeds = new_message.embeds.filter((embed) => embed.type === EmbedType.rich);
        const authorship = relayedAuthorship(req);
        if (authorship && req.user_id === message.author_id) new_message.authorship = authorship;

        await new_message.save();

        await emitEvent({
            event: "MESSAGE_UPDATE",
            channel_id,
            data: {
                ...new_message.toJSON(),
                nonce: undefined,
            },
        } satisfies MessageUpdateEvent);

        postHandleMessage(new_message).catch((e) => console.error("[Message] post-message handler failed", e));
        await syncCrosspostCopies(new_message);

        return res.json(new_message.toPublicJSON(req.user_id));
    },
);

// Backfill message with specific timestamp
router.put(
    "/",
    messageUpload.single("file"),
    parsePayloadJson,
    route({
        requestBody: "MessageCreateSchema",
        permission: "SEND_MESSAGES",
        right: "SEND_BACKDATED_EVENTS",
        responses: {
            200: {
                body: "PublicMessage",
            },
            400: {
                body: "APIErrorResponse",
            },
            403: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { channel_id, message_id } = req.params as { [key: string]: string };
        const body = req.body as MessageCreateSchema;
        const attachments: (MessageCreateAttachment | MessageCreateCloudAttachment)[] = body.attachments ?? [];

        const rights = await getRights(req.user_id);
        rights.hasThrow("SEND_MESSAGES");

        // regex to check if message contains anything other than numerals ( also no decimals )
        if (!message_id.match(/^\+?\d+$/)) {
            throw new HTTPError("Message IDs must be positive integers", 400);
        }

        const snowflake = Snowflake.deconstruct(message_id);
        if (Date.now() < snowflake.timestamp) {
            // message is in the future
            throw SpacebarApiErrors.CANNOT_BACKFILL_TO_THE_FUTURE;
        }

        const exists = await Message.findOne({
            where: { id: message_id, channel_id: channel_id },
        });
        if (exists) {
            throw SpacebarApiErrors.CANNOT_REPLACE_BY_BACKFILL;
        }

        if (req.file) {
            try {
                const file = await uploadFile(`/attachments/${req.params.channel_id}/${message_id}`, req.file);
                attachments.push(Attachment.create(file));
            } catch (error) {
                return res.status(400).json(error);
            }
        }
        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
            relations: { recipients: { user: true } },
        });

        const embeds = body.embeds || [];
        if (body.embed) embeds.push(body.embed);
        const message = await handleMessage({
            ...body,
            type: 0,
            pinned: false,
            author_id: req.user_id,
            id: message_id,
            embeds,
            channel_id: channel_id!,
            attachments,
            edited_timestamp: undefined,
            timestamp: new Date(snowflake.timestamp),
        });

        //Fix for the client bug
        delete message.member;

        await message.save();

        scheduleSavedPoll(message);
        const publicMsg = message.toJSON();
        await Promise.all([
            emitEvent({
                event: "MESSAGE_CREATE",
                channel_id: channel_id,
                data: publicMsg,
            } satisfies MessageCreateEvent),
            channel.save(),
        ]);

        // no await as it shouldnt block the message send function and silently catch error
        postHandleMessage(message).catch((e) => console.error("[Message] post-message handler failed", e));

        return res.json(
            message.withSignedAttachments(
                new NewUrlUserSignatureData({
                    ip: req.ip,
                    userAgent: req.headers["user-agent"] as string,
                }),
            ),
        );
    },
);

router.get(
    "/",
    route({
        permission: "VIEW_CHANNEL",
        responses: {
            200: {
                body: "PublicMessage",
            },
            400: {
                body: "APIErrorResponse",
            },
            403: {},
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { message_id, channel_id } = req.params as { [key: string]: string };

        const message = await Message.findOneOrFail({
            where: { id: message_id, channel_id },
            relations: {
                author: true,
                webhook: true,
                application: true,
                mentions: true,
                mention_roles: true,
                mention_channels: true,
                sticker_items: true,
                attachments: true,
                thread: { recipients: { user: true } },
            },
        });

        const permissions = await getPermission(req.user_id, undefined, channel_id);

        if (message.author_id !== req.user_id) permissions.hasThrow("READ_MESSAGE_HISTORY");

        return res.json(message.toPublicJSON(req.user_id));
    },
);

router.delete(
    "/",
    route({
        responses: {
            204: {},
            400: {
                body: "APIErrorResponse",
            },
            404: {},
        },
    }),
    async (req: Request, res: Response) => {
        const { message_id, channel_id } = req.params as { [key: string]: string };

        const channel = await Channel.findOneOrFail({
            where: { id: channel_id },
        });
        const message = await Message.findOneOrFail({
            where: { id: message_id, channel_id: channel_id },
        });

        const rights = await getRights(req.user_id);

        if (message.author_id !== req.user_id) {
            if (!rights.has("MANAGE_MESSAGES")) {
                const permission = await getPermission(req.user_id, channel.guild_id, channel_id);
                permission.hasThrow("MANAGE_MESSAGES");
            } else if (!(await permitted(async () => (await getPermission(req.user_id, channel.guild_id, channel_id)).has("MANAGE_MESSAGES"))))
                await noteRightsBypass(req, "MANAGE_MESSAGES", message.author_id);
        } else rights.hasThrow("SELF_DELETE_MESSAGES");

        await Message.delete({ id: message_id, channel_id: channel_id });
        if (channel.guild_id && message.author_id && message.author_id !== req.user_id)
            await AuditLog.logMessageDelete(channel.guild_id, req.user_id, message.author_id, channel_id, req.headers["x-audit-log-reason"]);
        if (channel.isThread() && message.id !== channel.id && message.type !== MessageType.THREAD_STARTER_MESSAGE && (channel.message_count ?? 0) > 0)
            await Channel.getRepository().decrement({ id: channel.id }, "message_count", 1);

        await emitEvent({
            event: "MESSAGE_DELETE",
            channel_id,
            data: {
                id: message_id,
                channel_id,
                guild_id: channel.guild_id,
            },
        } satisfies MessageDeleteEvent);
        await syncCrosspostCopies(message, true);

        res.sendStatus(204);
    },
);

export default router;
