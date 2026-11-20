import { Request, Response, Router } from "express";
import { route, parsePayloadJson } from "@spacebar/api/middlewares";
import { Webhook } from "@spacebar/database";
import { DiscordApiErrors, emitEvent, getInteractionByToken, WebhooksUpdateEvent } from "@spacebar/util";
import { applyWebhookUpdate, executeWebhook, webhookToJSON } from "@spacebar/api/util/handlers/Webhook";
import type { WebhookUpdateSchema } from "@spacebar/schemas";
import { boundedMessageUpload } from "@spacebar/api/util/utility/boundedUpload";
import { tokenEquals } from "@spacebar/api/util/utility/tokenEquals";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        description: "Returns a webhook object for the given id and token.",
        responses: {
            200: {
                body: "WebhookResponse",
            },
            404: {},
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { webhook_id, webhook_token } = req.params as { [key: string]: string };
        const webhook = await Webhook.findOne({
            where: {
                id: webhook_id,
            },
            relations: {
                user: true,
                channel: true,
                source_channel: true,
                guild: true,
                source_guild: true,
                application: true,
            },
        });

        if (!webhook) {
            throw DiscordApiErrors.UNKNOWN_WEBHOOK;
        }

        if (!tokenEquals(webhook.token, webhook_token)) {
            throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;
        }

        return res.json(webhookToJSON(webhook, { withToken: true }));
    },
);

const messageUpload = boundedMessageUpload();

// https://discord.com/developers/docs/resources/webhook#execute-webhook
router.post(
    "/",
    async (req, _res, next) => {
        const { webhook_id, webhook_token } = req.params as { [key: string]: string };
        const webhook = await Webhook.findOne({
            where: { id: webhook_id },
            select: { id: true, token: true },
        });
        if (!webhook) {
            if (!(await getInteractionByToken(webhook_id, webhook_token))?.acknowledged) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
            return next();
        }
        if (!tokenEquals(webhook.token, webhook_token)) throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;
        next();
    },
    messageUpload,
    parsePayloadJson,
    route({
        requestBody: "WebhookExecuteSchema",
        stripNulls: true,
        query: {
            wait: {
                type: "boolean",
                required: false,
                description: "waits for server confirmation of message send before response, and returns the created message body",
            },
            thread_id: {
                type: "string",
                required: false,
                description: "Send a message to the specified thread within a webhook's channel.",
            },
            with_components: {
                type: "boolean",
                required: false,
                description: "Whether to respect the components field of the request.",
            },
        },
        responses: {
            204: {},
            400: {
                body: "APIErrorResponse",
            },
            404: {},
        },
        authentication: "never",
    }),
    executeWebhook,
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
        const { webhook_id, webhook_token } = req.params as { [key: string]: string };

        const webhook = await Webhook.findOne({
            where: {
                id: webhook_id,
            },
            relations: { channel: true, guild: true, application: true },
        });

        if (!webhook) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
        if (!tokenEquals(webhook.token, webhook_token)) throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;

        const channel_id = webhook.channel_id;
        await Webhook.delete({ id: webhook_id });

        await emitEvent({
            event: "WEBHOOKS_UPDATE",
            channel_id,
            data: {
                channel_id,
                guild_id: webhook.guild_id!, // TODO: is this even the right fix?
            },
        } satisfies WebhooksUpdateEvent);

        res.sendStatus(204);
    },
);

router.patch(
    "/",
    route({
        requestBody: "WebhookUpdateSchema",
        responses: {
            200: {},
            400: {
                body: "APIErrorResponse",
            },
            403: {},
            404: {},
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { webhook_id, webhook_token } = req.params as { [key: string]: string };
        const body = req.body as WebhookUpdateSchema;

        const webhook = await Webhook.findOne({
            where: { id: webhook_id },
            relations: {
                user: true,
                channel: true,
                source_channel: true,
                guild: true,
                source_guild: true,
                application: true,
            },
        });

        if (!webhook) throw DiscordApiErrors.UNKNOWN_WEBHOOK;
        if (!tokenEquals(webhook.token, webhook_token)) throw DiscordApiErrors.INVALID_WEBHOOK_TOKEN_PROVIDED;

        const channel_id = webhook.channel_id;
        await applyWebhookUpdate(webhook, body, false);

        await Promise.all([
            webhook.save(),
            emitEvent({
                event: "WEBHOOKS_UPDATE",
                channel_id,
                data: {
                    channel_id,
                    guild_id: webhook.guild_id!, //TODO: is this even the right fix?
                },
            } satisfies WebhooksUpdateEvent),
        ]);
        res.json(webhookToJSON(webhook, { withToken: true }));
    },
);

export default router;
