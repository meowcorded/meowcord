import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Channel, StageInstances } from "@spacebar/database";
import { DiscordApiErrors, getPermission } from "@spacebar/util";
import { ChannelType } from "@spacebar/schemas";
import { HTTPError } from "lambert-server";

const router: Router = Router({ mergeParams: true });

export const stageModerator = async (userId: string, channelId: string) => {
    const channel = await Channel.findOne({
        where: { id: channelId },
        select: { id: true, guild_id: true, type: true },
    });
    if (!channel?.guild_id || channel.type !== ChannelType.GUILD_STAGE_VOICE) throw DiscordApiErrors.UNKNOWN_CHANNEL;
    const permissions = await getPermission(userId, channel.guild_id, channel.id);
    if (!permissions.has("VIEW_CHANNEL")) throw DiscordApiErrors.UNKNOWN_CHANNEL;
    const moderator = permissions.has("MANAGE_CHANNELS") && permissions.has("MUTE_MEMBERS") && permissions.has("MOVE_MEMBERS");
    if (moderator) permissions.assertMfa("MANAGE_CHANNELS");
    return {
        channel,
        permissions,
        moderator,
    };
};

router.get("/", route({ responses: { 200: {} } }), (req: Request, res: Response) => {
    res.json([]);
});

router.post("/", route({ responses: { 200: {}, 400: {}, 403: {}, 404: {} } }), async (req: Request, res: Response) => {
    const { channel_id, topic, privacy_level, guild_scheduled_event_id, send_start_notification } = req.body ?? {};
    if (typeof channel_id !== "string") throw new HTTPError("channel_id is required", 400);
    if (typeof topic !== "string" || !topic.trim() || topic.length > 120) throw new HTTPError("topic must be 1-120 characters", 400);
    const { channel, moderator, permissions } = await stageModerator(req.user_id, channel_id);
    if (!moderator) throw DiscordApiErrors.MISSING_PERMISSIONS;
    if (await StageInstances.get(channel.id)) throw DiscordApiErrors.STAGE_ALREADY_OPEN;
    const notifyHostId = send_start_notification === true && permissions.has("MENTION_EVERYONE") ? req.user_id : null;
    res.json(await StageInstances.create(channel.guild_id!, channel.id, topic.trim(), Number(privacy_level ?? 2), guild_scheduled_event_id ?? null, notifyHostId));
});

export default router;
