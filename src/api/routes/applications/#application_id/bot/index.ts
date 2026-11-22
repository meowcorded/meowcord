import { assertIdentityNameAllowed } from "@spacebar/util/util/IdentityModeration";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { requireMfaIfEnabled, revokeSessions } from "@spacebar/api/util";
import { Application } from "@spacebar/database";
import { DiscordApiErrors, FieldErrors, broadcastUserUpdate, createAppBotUser, generateToken, handleFile } from "@spacebar/util";
import { BotModifySchema } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            204: {
                body: "TokenOnlyResponse",
            },
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const app = await Application.findOneOrFail({
            where: { id: req.params.application_id as string },
            relations: { owner: true, bot: true },
        });

        if (app.owner.id != req.user_id) throw DiscordApiErrors.ACTION_NOT_AUTHORIZED_ON_APPLICATION;
        if (app.bot) throw new HTTPError("This application already has a bot", 400);

        const user = await createAppBotUser(app, req);

        res.send({
            token: await generateToken(user.id),
        });
    },
);

router.post(
    "/reset",
    route({
        responses: {
            200: {
                body: "TokenResponse",
            },
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const app = await Application.findOneOrFail({
            where: { id: req.params.application_id as string },
            relations: { bot: true },
        });

        if (!app.bot) throw DiscordApiErrors.OAUTH2_APPLICATION_BOT_ABSENT;
        if (app.owner_id != req.user_id) throw DiscordApiErrors.ACTION_NOT_AUTHORIZED_ON_APPLICATION;

        await requireMfaIfEnabled(req);

        app.bot.data = { hash: undefined, valid_tokens_since: new Date() };

        await app.bot.save();
        await revokeSessions(app.bot.id);

        const token = await generateToken(app.bot.id);

        res.json({ token }).status(200);
    },
);

router.patch(
    "/",
    route({
        requestBody: "BotModifySchema",
        responses: {
            200: {
                body: "PublicUser",
            },
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const body = req.body as BotModifySchema;
        if (!body.avatar?.trim()) delete body.avatar;

        if (body.username?.trim() == "") {
            throw FieldErrors({
                username: {
                    code: "BASE_TYPE_REQUIRED",
                    message: req.t("common:field.BASE_TYPE_REQUIRED"),
                },
            });
        }

        const app = await Application.findOneOrFail({
            where: { id: req.params.application_id as string },
            relations: { bot: true, owner: true },
        });

        if (!app.bot) throw DiscordApiErrors.BOT_ONLY_ENDPOINT;

        if (app.owner.id != req.user_id) throw DiscordApiErrors.ACTION_NOT_AUTHORIZED_ON_APPLICATION;

        assertIdentityNameAllowed(body.username);

        if (body.avatar) body.avatar = await handleFile(`/avatars/${app.id}`, body.avatar as string);

        const before = JSON.stringify(app.bot.toPublicUser());
        app.bot.assign(body);

        await app.bot.save();
        if (JSON.stringify(app.bot.toPublicUser()) !== before) await broadcastUserUpdate(app.bot.id);

        res.json(app.bot.toPublicUser());
    },
);

export default router;
