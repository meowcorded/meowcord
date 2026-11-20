import { scheduleSavedPoll } from "../utility/polls";
import { tokenEquals } from "../utility/tokenEquals";
import { Request, Response } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { MoreThan } from "typeorm";
import { MessageOptionAttachment } from "@spacebar/util/dtos/MessageOptions";
import { handleMessage, postHandleMessage } from "./Message";
import { createInteractionMessage, editInteractionMessage, fetchInteractionMessage } from "./Interaction";
import { Attachment, Channel, Message, User, Webhook } from "@spacebar/database";
import {
    Config,
    DiscordApiErrors,
    emitEvent,
    FieldErrors,
    getInteractionByToken,
    saveInteraction,
    MessageCreateEvent,
    MessageFlags,
    Snowflake,
    uploadFile,
    uploadMessageFiles,
    ValidateName,
    handleFile,
} from "@spacebar/util";
import { AccountStandingState, InteractionMessage, WebhookExecuteSchema, WebhookMessageEditSchema, WebhookResponse, WebhookUpdateSchema } from "@spacebar/schemas";

export const webhookToJSON = (webhook: Webhook, opts: { withToken?: boolean; withUser?: boolean } = { withToken: true, withUser: true }): WebhookResponse => ({
    id: webhook.id,
    type: webhook.type,
    guild_id: webhook.guild_id ?? null,
    channel_id: webhook.channel_id ?? null,
    name: webhook.name ?? null,
    avatar: webhook.avatar ?? null,
    application_id: webhook.application_id ?? null,
    ...(opts.withUser && webhook.user && { user: webhook.user.toPartialUser() }),
    ...(webhook.source_guild && { source_guild: webhook.source_guild.toIntegrationGuild() }),
    ...(webhook.source_channel && { source_channel: webhook.source_channel.toWebhookChannel() }),
    ...(opts.withToken &&
        webhook.token && {
            token: webhook.token,
            url: `${Config.get().api.endpointPublic}/webhooks/${webhook.id}/${webhook.token}`,
        }),
});

export async function applyWebhookUpdate(webhook: Webhook, body: WebhookUpdateSchema, allowChannel: boolean) {
    if (body.name === undefined && body.avatar === undefined && !(allowChannel && body.channel_id)) throw new HTTPError("Empty webhook updates are not allowed", 50006);
    if (body.name !== undefined) {
        ValidateName(body.name);
        webhook.name = body.name;
    }
    if (body.avatar !== undefined && body.avatar !== webhook.avatar)
        webhook.avatar = body.avatar ? ((await handleFile(`/avatars/${webhook.id}`, body.avatar, `webhook:${webhook.id}`)) ?? webhook.avatar) : (null as never);
    if (allowChannel && body.channel_id && body.channel_id !== webhook.channel_id) {
        const channel = await Channel.findOneOrFail({
            where: { id: body.channel_id, guild_id: webhook.guild_id },
        });
        webhook.channel_id = channel.id;
        webhook.channel = channel;
    }
}

export function applyWebhookComponents(webhook: Webhook, body: WebhookExecuteSchema | WebhookMessageEditSchema, withComponents: boolean) {
    if (!body.components) return;
    if (webhook.application_id) return;
    if (!withComponents) {
        delete body.components;
        return;
    }
    type Node = {
        type?: number;
        style?: number;
        components?: Node[];
        accessory?: Node;
        component?: Node;
    };
    const interactive = (nodes: Node[]): boolean =>
        nodes.some(
            (node) =>
                !!node &&
                ((node.type === 2 && node.style !== 5 && node.style !== 6) ||
                    [3, 4, 5, 6, 7, 8].includes(node.type ?? 0) ||
                    interactive([...(node.components ?? []), ...(node.accessory ? [node.accessory] : []), ...(node.component ? [node.component] : [])])),
        );
    if (interactive(body.components as Node[]))
        throw FieldErrors({
            components: {
                code: "COMPONENT_INTERACTIVE_NOT_ALLOWED",
                message: "Interactive components can only be sent by application-owned webhooks.",
            },
        });
}

export async function assertWebhookOwnerActive(webhook: Webhook) {
    if (!webhook.user_id) return;
    const owner = await User.findOne({
        where: { id: webhook.user_id },
        select: { id: true, disabled: true, deleted: true, account_standing: true },
    });
    if (!owner || owner.disabled || owner.deleted || owner.account_standing === AccountStandingState.SUSPENDED) throw new HTTPError("Webhook owner account unavailable", 403);
}

export const executeWebhook = async (req: Request, res: Response) => {
    const body = req.body as WebhookExecuteSchema;
    const messageId = Snowflake.generate();

    const { webhook_id, webhook_token } = req.params as { [key: string]: string };

    const webhook = await Webhook.findOne({
        where: {
            id: webhook_id,
        },
        relations: { channel: true, guild: true, application: true },
    });

    if (!webhook) {
        const interaction = await getInteractionByToken(webhook_id, webhook_token);
        if (!interaction?.acknowledged) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
        const files = (req.files as Express.Multer.File[]) ?? [];
        const uploaded = await Promise.all(
            files.map((file) =>
                uploadFile(`/attachments/${interaction.channelId}/${messageId}`, file, `application:${interaction.applicationId}`).then((f) => Attachment.create(f)),
            ),
        );
        const data = {
            ...body,
            attachments: uploaded.length ? uploaded : body.attachments,
        } as InteractionMessage;
        const original = interaction.responseLoading && interaction.responseMessageId ? await fetchInteractionMessage(interaction.responseMessageId) : null;
        if (interaction.responseLoading) {
            interaction.responseLoading = false;
            await saveInteraction(interaction);
        }
        const message = original ? await editInteractionMessage(interaction, original, data) : await createInteractionMessage(interaction, data, { followup: true });
        return res.json(message.toJSON());
    }
    if (!tokenEquals(webhook.token, webhook_token)) throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;
    await assertWebhookOwnerActive(webhook);
    applyWebhookComponents(webhook, body, req.query.with_components === "true");

    if (body.username) {
        ValidateName(body.username, 1, 80);
    }

    // ensure one of content, embeds, components, or file is present
    if (!body.content && !body.embeds && !body.components && !body.file && !body.attachments) {
        throw DiscordApiErrors.CANNOT_SEND_EMPTY_MESSAGE;
    }

    const wait = req.query.wait === "true";
    const thread_id = typeof req.query.thread_id === "string" ? req.query.thread_id : undefined;

    if (!wait) {
        res.status(204).send();
    }

    if (!webhook.channel.isWritable()) {
        if (wait) {
            throw new HTTPError(`Cannot send messages to channel of type ${webhook.channel.type}`, 400);
        } else {
            return;
        }
    }

    // TODO: creating messages by users checks if the user can bypass rate limits, we cant do that on webhooks, but maybe we could check the application if there is one?
    const limits = Config.get().limits;
    if (limits.absoluteRate.sendMessage.enabled) {
        const count = await Message.count({
            where: {
                channel_id: webhook.channel_id,
                timestamp: MoreThan(new Date(Date.now() - limits.absoluteRate.sendMessage.window)),
            },
        });

        if (count >= limits.absoluteRate.sendMessage.limit)
            if (wait) {
                throw FieldErrors({
                    channel_id: {
                        code: "TOO_MANY_MESSAGES",
                        message: req.t("common:toomany.MESSAGE"),
                    },
                });
            } else {
                return;
            }
    }

    let sendChannel = webhook.channel;
    if (thread_id) {
        sendChannel = await Channel.findOneOrFail({
            where: {
                id: thread_id,
                parent_id: webhook.channel.id,
            },
        });
    }

    const files = (req.files as Express.Multer.File[]) ?? [];
    let attachments: MessageOptionAttachment[];
    try {
        attachments = await uploadMessageFiles(`/attachments/${sendChannel.id}/${messageId}`, files, body.attachments ?? [], `webhook:${webhook.id}`);
    } catch (error) {
        if (wait) res.status(400).json({ message: error?.toString() });
        console.error("[webhookExecute] Failed to handle attachment:", error);
        return;
    }

    const embeds = body.embeds || [];
    const bodyMsg = {
        ...body,
        allowed_mentions: body.allowed_mentions
            ? {
                  ...body.allowed_mentions,
                  parse: body.allowed_mentions.parse as ("users" | "roles" | "everyone")[],
              }
            : undefined,
    } as Parameters<typeof handleMessage>[0];
    const message = await handleMessage({
        id: messageId,
        ...bodyMsg,
        flags: MessageFlags.settable(body.flags, MessageFlags.WEBHOOK_SETTABLE),
        username: body.username || webhook.name,
        avatar_url: body.avatar_url,
        type: 0,
        pinned: false,
        webhook_id: webhook.id,
        application_id: webhook.application?.id,
        embeds,
        // TODO: Support thread_id/thread_name once threads are implemented
        channel_id: sendChannel.id,
        attachments,
        timestamp: new Date(),
    });

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    //@ts-expect-error dont care2
    message.edited_timestamp = null;

    sendChannel.last_message_id = message.id;

    await Promise.all([message.save(), sendChannel.save()]);
    scheduleSavedPoll(message);
    await emitEvent({
        event: "MESSAGE_CREATE",
        channel_id: sendChannel.id,
        data: message.toJSON(),
    } satisfies MessageCreateEvent);

    // no await as it shouldnt block the message send function and silently catch error
    postHandleMessage(message).catch((e) => console.error("[Message] post-message handler failed", e));
    if (wait) res.json(message.toJSON());
    return;
};
