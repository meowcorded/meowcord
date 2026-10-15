/* SPDX-License-Identifier: AGPL-3.0-only */
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { AuditLog, Guild, User } from "@spacebar/database";
import { DiscordApiErrors, GuildUpdateEvent, emitEvent, getRights } from "@spacebar/util";
import { AuditLogEvents, GuildCreateResponse, GuildMFALevel, GuildMfaResponse, GuildMfaSchema } from "@spacebar/schemas";
import { noteRightsBypass, requireMfa } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        requestBody: "GuildMfaSchema",
        responses: {
            200: {
                body: "GuildMfaResponse",
            },
            400: {
                body: "APIErrorResponse",
            },
            401: {
                body: "APIErrorResponse",
            },
            403: {
                body: "APIErrorResponse",
            },
            404: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        const body = req.body as GuildMfaSchema;

        if (body.level !== GuildMFALevel.NONE && body.level !== GuildMFALevel.ELEVATED) throw DiscordApiErrors.INVALID_FORM_BODY;

        const guild = await Guild.findOne({
            where: { id: guild_id },
            relations: { emojis: true, roles: true, stickers: true },
        });
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;

        const rights = await getRights(req.user_id);
        if (!rights.has("MANAGE_GUILDS") && guild.owner_id !== req.user_id) throw DiscordApiErrors.MISSING_PERMISSIONS;
        if (guild.owner_id !== req.user_id) await noteRightsBypass(req, "MANAGE_GUILDS");

        const user = await User.findOneOrFail({
            where: { id: req.user_id },
            select: { id: true, mfa_enabled: true },
        });

        if (body.level === GuildMFALevel.ELEVATED && !user.mfa_enabled) throw DiscordApiErrors.TWO_FACTOR_REQUIRED;
        if (user.mfa_enabled) await requireMfa(req);

        const auditBefore = { mfa_level: guild.mfa_level };
        guild.mfa_level = body.level;
        await guild.save();

        const changes = AuditLog.diff(auditBefore, guild, ["mfa_level"]);
        if (changes.length)
            await AuditLog.log({
                guild_id,
                user_id: req.user_id,
                action_type: AuditLogEvents.GUILD_UPDATE,
                target_id: guild_id,
                changes,
                reason: req.headers["x-audit-log-reason"],
            });

        const data = guild.toJSON();
        delete data.template_id;

        await emitEvent({
            event: "GUILD_UPDATE",
            data: {
                ...data,
                afk_channel_id: data.afk_channel_id ?? undefined,
                public_updates_channel_id: data.public_updates_channel_id ?? undefined,
                rules_channel_id: data.rules_channel_id ?? undefined,
                system_channel_id: data.system_channel_id ?? undefined,
            } satisfies GuildCreateResponse,
            guild_id,
        } satisfies GuildUpdateEvent);

        return res.json({ level: guild.mfa_level } satisfies GuildMfaResponse);
    },
);

export default router;
