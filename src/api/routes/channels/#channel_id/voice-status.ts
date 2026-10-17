import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Channel, VoiceState } from "@spacebar/database";
import { DiscordApiErrors, emitEvent, getPermission } from "@spacebar/util";
import { ChannelType } from "@spacebar/schemas";
import { HTTPError } from "lambert-server";

const router: Router = Router({ mergeParams: true });

router.put("/", route({ responses: { 204: {}, 400: {}, 403: {}, 404: {} } }), async (req: Request, res: Response) => {
    const channel = await Channel.findOneOrFail({
        where: { id: req.params.channel_id as string },
        select: { id: true, guild_id: true, type: true },
    });
    if (!channel.guild_id || channel.type !== ChannelType.GUILD_VOICE) throw DiscordApiErrors.UNKNOWN_CHANNEL;

    const raw = req.body?.status;
    if (raw != null && typeof raw !== "string") throw new HTTPError("status must be a string", 400);
    const status = raw?.trim() ? raw.slice(0, 500) : null;

    const permissions = await getPermission(req.user_id, channel.guild_id, channel.id);
    const connected = await VoiceState.exists({
        where: { user_id: req.user_id, channel_id: channel.id },
    });
    if (!permissions.has("MANAGE_CHANNELS") && !(connected && permissions.has("SET_VOICE_CHANNEL_STATUS")))
        throw DiscordApiErrors.MISSING_PERMISSIONS.withParams("SET_VOICE_CHANNEL_STATUS");
    if (!connected || !permissions.has("SET_VOICE_CHANNEL_STATUS")) permissions.assertMfa("MANAGE_CHANNELS");

    await Channel.update({ id: channel.id }, { status });
    await emitEvent({
        event: "VOICE_CHANNEL_STATUS_UPDATE",
        guild_id: channel.guild_id,
        data: { id: channel.id, guild_id: channel.guild_id, status },
    });
    res.sendStatus(204);
});

export default router;
