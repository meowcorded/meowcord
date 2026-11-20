import { Request, Response, Router } from "express";
import { Not } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { APPLICATION_EMBEDDED, APPLICATION_EMBEDDED_RELEASED, enableApplicationActivity } from "@spacebar/api/activities";
import { forgetActivityLookup } from "@spacebar/api/activities/ActivityHost";
import { ensureInteractionKeys, toOwnedApplication, verifyInteractionsEndpoint } from "@spacebar/api/util/handlers/Application";
import { Application, ApplicationCommand, Guild, Member, Message, User } from "@spacebar/database";
import { DiscordApiErrors, emitEvent, FieldErrors, GuildIntegrationUpdateEvent, handleFile } from "@spacebar/util";
import { emitCommandIndexUpdate } from "@spacebar/api/util/handlers/ApplicationCommands";
import { isAllowedRedirectUri, revokeSessions, throttledCodeAttempt, verifyTotp } from "@spacebar/api/util";
import { ApplicationModifySchema } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "Application",
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
        if (!/^[0-9a-f]{64}$/.test(app.verify_key)) {
            await ensureInteractionKeys(app.id);
            app.verify_key = (
                await Application.findOneOrFail({
                    where: { id: app.id },
                    select: { id: true, verify_key: true },
                })
            ).verify_key;
        }

        return res.json(toOwnedApplication(app));
    },
);

router.patch(
    "/",
    route({
        requestBody: "ApplicationModifySchema",
        responses: {
            200: {
                body: "Application",
            },
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const body = req.body as ApplicationModifySchema;

        const app = await Application.findOneOrFail({
            where: { id: req.params.application_id as string },
            relations: { owner: true, bot: true },
        });

        if (app.owner.id != req.user_id) throw DiscordApiErrors.ACTION_NOT_AUTHORIZED_ON_APPLICATION;

        const { totp_secret } = await User.findOneOrFail({ where: { id: req.user_id }, select: { id: true, totp_secret: true } });
        if (totp_secret && (!req.body.code || !(await throttledCodeAttempt(req.user_id, () => verifyTotp(totp_secret, req.body.code)))))
            throw new HTTPError(req.t("auth:login.INVALID_TOTP_CODE"), 60008);

        if (body.name?.trim() == "") {
            throw FieldErrors({
                name: {
                    code: "BASE_TYPE_REQUIRED",
                    message: req.t("common:field.BASE_TYPE_REQUIRED"),
                },
            });
        }

        if (body.redirect_uris) {
            const invalid = body.redirect_uris.findIndex((uri) => !isAllowedRedirectUri(uri));
            if (invalid !== -1)
                throw FieldErrors({
                    [`redirect_uris.${invalid}`]: {
                        code: "URL_TYPE_INVALID_URL",
                        message: "Not a well formed URL.",
                    },
                });
            body.redirect_uris = [...new Set(body.redirect_uris)];
        }

        if (body.guild_id) {
            const guild = await Guild.findOneOrFail({
                where: { id: body.guild_id },
                select: { owner_id: true },
            });
            if (guild.owner_id != req.user_id) throw new HTTPError("You must be the owner of the guild to link it to an application", 400);
        }

        if (body.interactions_endpoint_url !== undefined && body.interactions_endpoint_url !== app.interactions_endpoint_url) {
            if (body.interactions_endpoint_url && !(await verifyInteractionsEndpoint(app.id, body.interactions_endpoint_url)))
                throw FieldErrors({
                    interactions_endpoint_url: {
                        code: "APPLICATION_INTERACTIONS_ENDPOINT_URL_INVALID",
                        message: "The specified interactions endpoint url could not be verified.",
                    },
                });
            app.verify_key = (
                await Application.findOneOrFail({
                    where: { id: app.id },
                    select: { id: true, verify_key: true },
                })
            ).verify_key;
            body.interactions_endpoint_url ||= null;
        }

        if (body.icon) {
            body.icon = await handleFile(`/app-icons/${app.id}`, body.icon as string);
        }
        if (body.cover_image) {
            body.cover_image = await handleFile(`/app-icons/${app.id}`, body.cover_image as string);
        }

        if (body.custom_install_url && !/^https?:$/.test(URL.canParse(body.custom_install_url) ? new URL(body.custom_install_url).protocol : ""))
            throw FieldErrors({
                custom_install_url: { code: "URL_TYPE_INVALID_URL", message: "Not a well formed URL." },
            });
        if (body.custom_install_url === "") body.custom_install_url = null;

        if (body.integration_types_config) {
            const config = body.integration_types_config;
            if (!config["0"] && !config["1"])
                throw FieldErrors({
                    integration_types_config: {
                        code: "BASE_TYPE_REQUIRED",
                        message: "Pick at least one installation context.",
                    },
                });
            for (const [type, entry] of Object.entries(config)) {
                const params = entry?.oauth2_install_params;
                if (!params) continue;
                const allowed = type === "1" ? ["applications.commands"] : ["bot", "applications.commands", "webhook.incoming"];
                if (!params.scopes.length || params.scopes.some((scope) => !allowed.includes(scope)) || !/^\d+$/.test(params.permissions || "0"))
                    throw FieldErrors({
                        [`integration_types_config.${type}.oauth2_install_params`]: {
                            code: "BASE_TYPE_CHOICES",
                            message: "Invalid install scopes or permissions.",
                        },
                    });
                params.permissions = params.scopes.includes("bot") ? params.permissions || "0" : "0";
            }
        }

        for (const key of ["terms_of_service_url", "privacy_policy_url"] as const) {
            const value = body[key];
            if (value === undefined) continue;
            if (!value?.trim()) {
                body[key] = null;
                continue;
            }
            if (!/^https?:$/.test(URL.canParse(value.trim()) ? new URL(value.trim()).protocol : ""))
                throw FieldErrors({
                    [key]: { code: "URL_TYPE_INVALID_URL", message: "Not a well formed URL." },
                });
            body[key] = value.trim();
        }

        if (body.tags) {
            body.tags = [...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean))];
            const invalid = body.tags.findIndex((tag) => tag.length > 20);
            if (invalid !== -1)
                throw FieldErrors({
                    [`tags.${invalid}`]: {
                        code: "BASE_TYPE_MAX_LENGTH",
                        message: "Tags can be up to 20 characters long.",
                    },
                });
        }

        const enablesActivity = body.flags !== undefined && !!(body.flags & APPLICATION_EMBEDDED) && !(app.flags & APPLICATION_EMBEDDED);
        if (body.flags !== undefined) {
            const editable = (1 << 8) | (1 << 13) | (1 << 15) | (1 << 19) | APPLICATION_EMBEDDED | APPLICATION_EMBEDDED_RELEASED;
            const flags = body.flags & APPLICATION_EMBEDDED ? body.flags : body.flags & ~APPLICATION_EMBEDDED_RELEASED;
            body.flags = (app.flags & ~editable) | (flags & editable);
        }

        app.assign(body as Partial<Application>);
        if (body.tags !== undefined) app.tags = body.tags;
        if (body.redirect_uris !== undefined) app.redirect_uris = body.redirect_uris;
        if (body.integration_types_config !== undefined) app.integration_types_config = body.integration_types_config;

        await Application.getRepository().manager.transaction(async (manager) => {
            await manager.save(app);
            if (app.bot && body.description !== undefined) {
                app.bot.assign({ bio: body.description });
                await manager.save(app.bot);
            }
        });
        if (enablesActivity) await enableApplicationActivity(app);
        if (body.flags !== undefined) forgetActivityLookup(app.id);

        return res.json(toOwnedApplication(app));
    },
);

router.post(
    "/delete",
    route({
        responses: {
            200: {},
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const app = await Application.findOneOrFail({
            where: { id: req.params.application_id as string },
            relations: { bot: true, owner: true },
        });
        if (app.owner.id != req.user_id) throw DiscordApiErrors.ACTION_NOT_AUTHORIZED_ON_APPLICATION;

        const { totp_secret } = await User.findOneOrFail({ where: { id: req.user_id }, select: { id: true, totp_secret: true } });
        if (totp_secret && (!req.body.code || !(await throttledCodeAttempt(req.user_id, () => verifyTotp(totp_secret, req.body.code)))))
            throw new HTTPError(req.t("auth:login.INVALID_TOTP_CODE"), 60008);
        if (app.bot) {
            const memberships = await Member.find({
                where: { id: app.bot.id, guild: { owner_id: Not(app.bot.id) } },
                select: { guild_id: true },
            });
            for (const { guild_id } of memberships) {
                await Member.removeFromGuild(app.bot.id, guild_id);
                await emitEvent({
                    event: "GUILD_INTEGRATIONS_UPDATE",
                    guild_id,
                    data: { guild_id },
                } satisfies GuildIntegrationUpdateEvent);
                await emitCommandIndexUpdate(app.id, guild_id);
            }
            await revokeSessions(app.bot.id);
            await User.update(
                { id: app.bot.id },
                {
                    deleted: true,
                    username: "Deleted User",
                    discriminator: "0000",
                    global_name: null,
                    avatar: () => "NULL",
                    banner: () => "NULL",
                    bio: "",
                },
            );
        }
        await ApplicationCommand.delete({ application_id: app.id });
        await Message.update({ application_id: app.id }, { application_id: () => "NULL" });
        await Application.delete({ id: app.id });

        res.send().status(200);
    },
);

export default router;
