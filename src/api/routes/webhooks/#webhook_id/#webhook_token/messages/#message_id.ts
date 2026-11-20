import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import multer from "multer";
import { handleMessage, postHandleMessage } from "@spacebar/api/util";
import { applyWebhookComponents, assertWebhookOwnerActive } from "@spacebar/api/util/handlers/Webhook";
import { route } from "@spacebar/api/middlewares";
import { Channel, Message, Webhook } from "@spacebar/database";
import { MessageDeleteEvent, MessageFlags, MessageUpdateEvent, emitEvent, DiscordApiErrors, getInteractionByToken, saveInteraction } from "@spacebar/util";
import { deleteInteractionMessage, editInteractionMessage, fetchInteractionMessage, messageBelongsToInteraction } from "@spacebar/api/util/handlers/Interaction";
import { ChannelType, PublicMessage, WebhookMessageEditSchema } from "@spacebar/schemas";

import { componentMessageErrors } from "@spacebar/api/util/handlers/ComponentValidation";
import { FieldErrors } from "@spacebar/util";
import { tokenEquals } from "@spacebar/api/util/utility/tokenEquals";

const router = Router({ mergeParams: true });

async function interactionMessage(req: Request) {
    const { webhook_id, webhook_token, message_id } = req.params as { [key: string]: string };
    const interaction = await getInteractionByToken(webhook_id, webhook_token);
    if (!interaction) return undefined;
    const id = message_id === "@original" ? interaction.responseMessageId : /^\d+$/.test(message_id) ? message_id : undefined;
    const message = id ? await fetchInteractionMessage(id) : null;
    if (!message) throw DiscordApiErrors.UNKNOWN_MESSAGE;
    const isSource = message.id === interaction.messageId;
    if (!isSource && !messageBelongsToInteraction(interaction, message)) throw DiscordApiErrors.UNKNOWN_MESSAGE;
    return { interaction, message };
}
// TODO: message content/embed string length limit

async function assertValidWebhookAuth(webhookId: string, webhookToken: string, messageId: string) {
    const webhook = await Webhook.findOne({ where: { id: webhookId } });
    if (!webhook) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
    if (!tokenEquals(webhook.token, webhookToken)) throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;

    await assertWebhookOwnerActive(webhook);

    // TODO: fix error responses
    if (!/^\d+$/.test(messageId)) throw DiscordApiErrors.UNKNOWN_MESSAGE;
    const message = await Message.findOne({ where: { id: messageId } });
    if (!message) throw new HTTPError(`No message found with ID ${messageId}`, 404);
    if (webhook.id != message?.webhook_id) throw new HTTPError(`Message does not belong to webhook ${message.webhook_id}`, 401);
    if (webhook.channel_id != message?.channel_id) throw new HTTPError(`Message does not belong to webhook channel ${message.channel_id}`, 401);
    return webhook;
}

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
        requestBody: "WebhookMessageEditSchema",
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
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { webhook_id, webhook_token, message_id } = req.params as { [key: string]: string };
        const body = req.body as WebhookMessageEditSchema;

        const fromInteraction = await interactionMessage(req);
        if (fromInteraction) {
            const edited = await editInteractionMessage(fromInteraction.interaction, fromInteraction.message, body as Parameters<typeof editInteractionMessage>[2]);
            if (edited.id === fromInteraction.interaction.responseMessageId && fromInteraction.interaction.responseLoading) {
                fromInteraction.interaction.responseLoading = false;
                await saveInteraction(fromInteraction.interaction);
            }
            return res.json(edited.toJSON());
        }

        const webhook = await assertValidWebhookAuth(webhook_id, webhook_token, message_id);
        applyWebhookComponents(webhook, body, req.query.with_components === "true");

        const message = await Message.findOneOrFail({
            where: { id: message_id, webhook_id: webhook_id },
            relations: { attachments: true },
        });

        const componentErrors = componentMessageErrors({ ...message, ...body }, message.flags);
        if (Object.keys(componentErrors).length) throw FieldErrors(componentErrors);

        const new_message = await handleMessage(
            {
                ...message,
                // TODO: should message_reference be overridable?
                message_reference: message.message_reference,
                ...body,
                flags: body.flags == null ? message.flags : (message.flags & ~MessageFlags.WEBHOOK_SETTABLE) | MessageFlags.settable(body.flags, MessageFlags.WEBHOOK_SETTABLE),
                content: body.content === undefined ? message.content : (body.content ?? ""),
                // author_id: message.author_id,
                author_id: undefined, // skip rights check
                webhook_id: message.webhook_id,
                channel_id: message.channel_id,
                id: message_id,
                edited_timestamp: new Date(),
            },
            { componentsChanged: body.components !== undefined },
        );

        await new_message.save();
        await emitEvent({
            event: "MESSAGE_UPDATE",
            channel_id: message.channel_id,
            data: {
                ...new_message.toJSON(),
                nonce: undefined,
            },
        } satisfies MessageUpdateEvent);

        postHandleMessage(new_message).catch((e) => console.error("[Message] post-message handler failed", e));
        return res.json(new_message.toJSON());
    },
);

router.get(
    "/",
    route({
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
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { webhook_id, webhook_token, message_id } = req.params as { [key: string]: string };

        const fromInteraction = await interactionMessage(req);
        if (fromInteraction) return res.json(fromInteraction.message.toJSON());

        await assertValidWebhookAuth(webhook_id, webhook_token, message_id);

        const message = await Message.findOneOrFail({
            where: { id: message_id, webhook_id: webhook_id },
            relations: {
                attachments: true,
                author: true,
            },
        });

        return res.json(message.toJSON());
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
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { webhook_id, webhook_token, message_id } = req.params as { [key: string]: string };

        const fromInteraction = await interactionMessage(req);
        if (fromInteraction) {
            await deleteInteractionMessage(fromInteraction.interaction, fromInteraction.message);
            return res.sendStatus(204);
        }

        await assertValidWebhookAuth(webhook_id, webhook_token, message_id);

        const message = await Message.findOneOrFail({
            where: { id: message_id, webhook_id: webhook_id },
        });

        const channel = await Channel.findOneOrFail({
            where: { id: message.channel_id },
        });

        if (channel.type === ChannelType.GUILD_PUBLIC_THREAD) {
            if (channel.message_count !== undefined) channel.message_count--;
            await channel.save();
        }

        await Message.delete({ id: message_id, webhook_id: webhook_id });

        await emitEvent({
            event: "MESSAGE_DELETE",
            channel_id: message.channel_id,
            data: {
                id: message_id,
                channel_id: message.channel_id!,
                guild_id: channel.guild_id,
            },
        } satisfies MessageDeleteEvent);

        res.sendStatus(204);
    },
);

export default router;
