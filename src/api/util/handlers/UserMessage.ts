import { sqlGreatest } from "@spacebar/database/Sql";
import { scheduleSavedPoll } from "../utility/polls";
import { Channel, Member, ReadState } from "@spacebar/database";
import { emitEvent, MessageCreateEvent, Permissions, getPermission, Snowflake } from "@spacebar/util";
import { MessageOptionAttachment } from "@spacebar/util/dtos/MessageOptions";
import { MessageCreateSchema, MessageType } from "@spacebar/schemas";
import { handleMessage, postHandleMessage } from "./Message";
import { reopenDirectMessage } from "./DirectMessage";
import { onThreadMessage } from "./Thread";
import { persistWithMessageSlowmode } from "./Slowmode";

export async function publishUserMessage(opts: {
    channel: Channel;
    user_id: string;
    body: MessageCreateSchema;
    message_id: string;
    attachments: MessageOptionAttachment[];
    permission?: Permissions;
}) {
    const { channel, user_id, body, message_id, attachments, permission } = opts;
    const last_message_id = channel.last_message_id || null;
    const embeds = body.embeds || [];
    if (body.embed) embeds.push(body.embed);
    const message = await handleMessage(
        {
            ...body,
            id: message_id,
            type: 0,
            pinned: false,
            author_id: user_id,
            embeds,
            channel_id: channel.id,
            attachments,
            timestamp: new Date(),
        },
        { channel, permission, deferChannelUpdates: true },
    );
    Object.assign(message, { edited_timestamp: null });

    if (message.guild_id) {
        if (!message.member) {
            message.member = await Member.findOneOrFail({
                where: { id: user_id, guild_id: message.guild_id },
                relations: { roles: true },
            });
            message.member.clean_data();
        }

        Object.assign(message.member, {
            roles: message.member.roles.filter((x) => x.id != x.guild_id).map((x) => x.id),
        });
    }

    const authorPermission = permission ?? (channel.guild_id && channel.rate_limit_per_user ? await getPermission(user_id, channel.guild_id, channel) : Permissions.NONE);
    const ephemeral = (message.flags & (1 << 6)) !== 0;
    const updateThreadCounters = !ephemeral && channel.isThread() && message.type !== MessageType.THREAD_STARTER_MESSAGE && message.id !== channel.id;
    await persistWithMessageSlowmode(channel, user_id, authorPermission, async (manager) => {
        message.timestamp = new Date();
        const readStates = manager?.getRepository(ReadState) ?? ReadState.getRepository();
        const members = manager?.getRepository(Member) ?? Member.getRepository();
        const channels = manager?.getRepository(Channel) ?? Channel.getRepository();
        const writes = [
            () => (manager ? manager.save(message) : message.save()),
            () =>
                readStates.query(
                    `INSERT INTO read_states (id, channel_id, user_id, last_message_id, mention_count)
                 VALUES ($1, $2, $3, $4, 0)
                 ON CONFLICT (channel_id, user_id) DO UPDATE SET
                     last_message_id = ${sqlGreatest("COALESCE(read_states.last_message_id, EXCLUDED.last_message_id)", "EXCLUDED.last_message_id")},
                     mention_count = 0`,
                    [Snowflake.generate(), channel.id, user_id, message.id],
                ),
            () => (message.guild_id ? members.update({ id: user_id, guild_id: message.guild_id }, { last_message_id: message.id }) : undefined),
            () => (!ephemeral ? channels.update({ id: channel.id }, { last_message_id: message.id }) : undefined),
        ];
        if (manager) for (const write of writes) await write();
        else await Promise.all(writes.map((write) => write()));
        if (updateThreadCounters) {
            await channels.increment({ id: channel.id }, "message_count", 1);
            await channels.increment({ id: channel.id }, "total_message_sent", 1);
        }
    });
    scheduleSavedPoll(message);
    if (!ephemeral) channel.last_message_id = message.id;
    if (updateThreadCounters) {
        channel.message_count = (channel.message_count ?? 0) + 1;
        channel.total_message_sent = (channel.total_message_sent ?? 0) + 1;
    }
    await reopenDirectMessage(channel, user_id, { last_message_id });

    if (channel.isThread())
        await onThreadMessage(
            channel,
            user_id,
            message.mentions?.map((user) => user.id),
        );

    await emitEvent({
        event: "MESSAGE_CREATE",
        channel_id: channel.id,
        data: { ...message.toJSON(), nonce: message.nonce ?? undefined },
    } satisfies MessageCreateEvent);

    postHandleMessage(message, permission).catch((e) => console.error("[Message] post-message handler failed", e));
    return message;
}
