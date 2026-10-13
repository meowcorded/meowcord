import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { DiscordApiErrors } from "@spacebar/util";
import { GuildTheme } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({}),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        const guild = await Guild.findOne({ where: { id: guild_id } });
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;

        const theme = guild.theme ?? null;
        return res.json({
            theme,
            preset_id: theme?.preset_id ?? null,
            custom_user_theme_settings: theme?.custom_user_theme_settings ?? null,
            enabled: theme?.enabled ?? false,
        });
    },
);

router.patch(
    "/",
    route({
        permission: "MANAGE_GUILD",
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        const guild = await Guild.findOne({ where: { id: guild_id } });
        if (!guild) throw DiscordApiErrors.UNKNOWN_GUILD;

        const body = req.body ?? {};
        const enabled = Boolean(body.enabled);
        const preset_id = typeof body.preset_id === "number" ? body.preset_id : null;
        let custom_user_theme_settings = null;

        if (body.custom_user_theme_settings && typeof body.custom_user_theme_settings === "object") {
            const c = body.custom_user_theme_settings;
            custom_user_theme_settings = {
                colors: Array.isArray(c.colors) ? c.colors.map(String) : [],
                gradient_color_stops: Array.isArray(c.gradient_color_stops) ? c.gradient_color_stops : [],
                gradient_angle: typeof c.gradient_angle === "number" ? c.gradient_angle : 0,
                base_mix: typeof c.base_mix === "number" ? c.base_mix : 0,
            };
        }

        const theme: GuildTheme = {
            preset_id,
            custom_user_theme_settings,
            enabled,
        };

        guild.theme = theme;
        await guild.save();

        await Guild.emitUpdate(guild_id);

        return res.json({
            theme,
            ...theme,
        });
    },
);

export default router;
