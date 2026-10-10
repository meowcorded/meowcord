import { lockTransaction } from "@spacebar/database/Sql";
import { Channel, Message, RateLimit } from "@spacebar/database";
import { ApiError, Config, Permissions } from "@spacebar/util";
import { EntityManager, IsNull } from "typeorm";

const SLOWMODE_RETENTION_SECONDS = 21600;

export function requiresMessageSlowmode(channel: Channel, permission: Permissions) {
    if (!channel.guild_id || !channel.rate_limit_per_user) return false;
    if (!Config.get().limits.channel.allowSlowmodeBypass) return true;
    return !permission.has("MANAGE_MESSAGES") && !permission.has("MANAGE_CHANNELS") && !permission.has("BYPASS_SLOWMODE");
}

export async function messageSlowmodeCooldown(channel: Channel, user_id: string, permission: Permissions, manager?: EntityManager) {
    if (!requiresMessageSlowmode(channel, permission)) return 0;
    const cooldown = await (manager?.getRepository(RateLimit) ?? RateLimit.getRepository()).findOneBy({ id: `message-slowmode:${channel.id}:${user_id}` });
    const last = await (manager?.getRepository(Message) ?? Message.getRepository()).findOne({
        where: { channel_id: channel.id, author_id: user_id, webhook_id: IsNull() },
        select: { timestamp: true },
        order: { timestamp: "DESC" },
    });
    const lastSuccess = Math.max(cooldown ? cooldown.expires_at.getTime() - cooldown.hits * 1000 : 0, last?.timestamp.getTime() ?? 0);
    const remaining = lastSuccess ? lastSuccess + channel.rate_limit_per_user! * 1000 - Date.now() : 0;
    return Math.max(0, remaining);
}

export async function assertMessageSlowmode(channel: Channel, user_id: string, permission: Permissions, manager?: EntityManager) {
    const remaining = await messageSlowmodeCooldown(channel, user_id, permission, manager);
    if (remaining > 0)
        throw Object.assign(new ApiError("You are being rate limited.", 20016, 429), {
            retry_after: remaining / 1000,
        });
}

export async function persistWithMessageSlowmode<T>(channel: Channel, user_id: string, permission: Permissions, persist: (manager?: EntityManager) => Promise<T>) {
    if (!requiresMessageSlowmode(channel, permission)) return persist();
    return Message.getRepository().manager.transaction(async (manager) => {
        await lockTransaction(manager, `message-slowmode:${channel.id}:${user_id}`);
        await assertMessageSlowmode(channel, user_id, permission, manager);
        const result = await persist(manager);
        await manager.upsert(
            RateLimit,
            {
                id: `message-slowmode:${channel.id}:${user_id}`,
                executor_id: user_id,
                hits: SLOWMODE_RETENTION_SECONDS,
                blocked: true,
                expires_at: new Date(Date.now() + SLOWMODE_RETENTION_SECONDS * 1000),
            },
            ["id"],
        );
        return result;
    });
}
