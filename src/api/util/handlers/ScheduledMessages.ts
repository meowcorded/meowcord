import { sqlNow } from "@spacebar/database/Sql";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";
import { Channel, ScheduledMessage, ScheduledMessagePayload, ScheduledMessageState, User, getDatabase } from "@spacebar/database";
import { Config, DiscordApiErrors, FieldErrors, getPermission, getRights, Snowflake } from "@spacebar/util";
import { MessageCreateSchema, MessageType } from "@spacebar/schemas";
import { MessageOptionAttachment } from "@spacebar/util/dtos/MessageOptions";
import { assertCanSendDirectMessage } from "./DirectMessage";
import { publishUserMessage } from "./UserMessage";
import { checkAutomod } from "../utility/automod";
import { dispatchClaimedScheduledMessage } from "./ScheduledMessageDispatch";

export const SCHEDULED_MESSAGE_MIN_DELAY_MS = 600_000;
export const SCHEDULED_MESSAGE_MAX_DELAY_MS = 691_200_000;

export function validateScheduledSendAt(raw: unknown) {
    const send_at = new Date(String(raw));
    const delay = send_at.getTime() - Date.now();
    if (Number.isNaN(delay) || delay < SCHEDULED_MESSAGE_MIN_DELAY_MS - 60_000 || delay > SCHEDULED_MESSAGE_MAX_DELAY_MS + 60_000)
        throw FieldErrors({
            scheduled_timestamp: {
                code: "BASE_TYPE_INVALID",
                message: "Scheduled messages must be sent between 10 minutes and 8 days from now.",
            },
        });
    return send_at;
}

export function validateScheduledContent(payload: ScheduledMessagePayload) {
    const { maxCharacters } = Config.get().limits.message;
    if ((payload.content?.length ?? 0) > maxCharacters)
        throw FieldErrors({
            content: {
                code: "BASE_TYPE_MAX_LENGTH",
                message: `Must be ${maxCharacters} or fewer in length.`,
            },
        });
    if (!payload.content?.trim() && !payload.attachments?.length && !payload.sticker_ids?.length && !payload.poll) throw DiscordApiErrors.CANNOT_SEND_EMPTY_MESSAGE;
}

export function scheduledMessageJSON(scheduled: ScheduledMessage, author: User, guild_id?: string | null) {
    const { payload } = scheduled;
    const send_at = scheduled.send_at.toISOString();
    const reply = !!payload.message_reference?.message_id;
    return {
        user_id: scheduled.user_id,
        scheduled_message_id: scheduled.id,
        send_at_timestamp: send_at,
        state: scheduled.state,
        create_args: {
            channel_id: scheduled.channel_id,
            content: payload.content ?? "",
            type: reply ? MessageType.REPLY : MessageType.DEFAULT,
            flags: payload.flags ?? 0,
            message_reference: payload.message_reference ?? null,
        },
        attachment_uploads: (payload.attachments ?? []).map(({ filename, uploaded_filename, description, title }) => ({
            filename,
            uploaded_filename,
            description,
            title,
        })),
        message_preview: {
            id: scheduled.id,
            channel_id: scheduled.channel_id,
            guild_id: guild_id ?? undefined,
            author: author.toPublicUser(),
            content: payload.content ?? "",
            type: reply ? MessageType.REPLY : MessageType.DEFAULT,
            flags: payload.flags ?? 0,
            timestamp: send_at,
            edited_timestamp: null,
            tts: false,
            pinned: false,
            mention_everyone: false,
            mentions: [],
            mention_roles: [],
            attachments: (payload.attachments ?? []).map((attachment, index) => ({
                id: `${index}`,
                filename: attachment.filename,
                size: 0,
                url: "",
                proxy_url: "",
                description: attachment.description,
            })),
            embeds: [],
            components: [],
            sticker_items: [],
            message_reference: payload.message_reference ?? undefined,
            poll: payload.poll ?? undefined,
        },
    };
}

export async function sendScheduledMessage(scheduled: ScheduledMessage) {
    const user = await User.findOne({ where: { id: scheduled.user_id } });
    if (!user) return ScheduledMessageState.ERROR_USER_NOT_FOUND;
    const channel = await Channel.findOne({
        where: { id: scheduled.channel_id },
        relations: { recipients: { user: true } },
    });
    if (!channel) return ScheduledMessageState.ERROR_CHANNEL_NOT_FOUND;
    try {
        const permission = await getPermission(user.id, channel.guild_id ?? undefined, channel);
        permission.hasThrow("VIEW_CHANNEL");
        permission.hasThrow(channel.isThread() ? "SEND_MESSAGES_IN_THREADS" : "SEND_MESSAGES");
        if (!(await getRights(user.id)).has("SEND_MESSAGES")) return ScheduledMessageState.ERROR_USER_CANNOT_USE_SCHEDULED_MESSAGES;
        if (!channel.isWritable()) return ScheduledMessageState.ERROR_CHANNEL_NOT_FOUND;
        await assertCanSendDirectMessage(channel, user.id);
        if (channel.guild_id)
            await checkAutomod({
                guild_id: channel.guild_id,
                channel,
                user_id: user.id,
                content: scheduled.payload.content,
                permission,
            });
        const body = { ...scheduled.payload } as MessageCreateSchema;
        await publishUserMessage({
            channel,
            user_id: user.id,
            body,
            message_id: Snowflake.generate(),
            attachments: (scheduled.payload.attachments ?? []) as MessageOptionAttachment[],
            permission,
        });
        return null;
    } catch (error) {
        console.error(`[ScheduledMessages] failed to send ${scheduled.id}`, error);
        return ScheduledMessageState.ERROR_SEND_FAILED;
    }
}

export async function dispatchScheduledMessage(scheduled: ScheduledMessage, onlyDue = false) {
    const database = getDatabase()!;
    return dispatchClaimedScheduledMessage((sql, parameters) => database.query(sql, parameters), scheduled.id, sendScheduledMessage, onlyDue);
}

let stopping = false;
let workerTimer: NodeJS.Timeout | undefined;
let sendingDue: Promise<void> | undefined;

export function sendDueScheduledMessages() {
    if (stopping) return sendingDue ?? Promise.resolve();
    if (sendingDue) return sendingDue;
    sendingDue = (async () => {
        const due = await ScheduledMessage.createQueryBuilder("scheduled")
            .select("scheduled.id")
            .where("scheduled.state = :state", { state: ScheduledMessageState.SCHEDULED })
            .andWhere(`scheduled.send_at <= ${sqlNow()}`)
            .andWhere(`(scheduled.claim_until IS NULL OR scheduled.claim_until <= ${sqlNow()})`)
            .orderBy("scheduled.send_at", "ASC")
            .addOrderBy("scheduled.id", "ASC")
            .take(100)
            .getMany();
        for (const scheduled of due) {
            if (stopping) break;
            await dispatchScheduledMessage(scheduled, true).catch((error) => console.error(`[ScheduledMessages] dispatch failed for ${scheduled.id}`, error));
        }
    })().finally(() => {
        sendingDue = undefined;
    });
    return sendingDue;
}

export function startScheduledMessageSender() {
    if (workerTimer || stopping) return workerTimer;
    const run = () => sendDueScheduledMessages().catch((error) => console.error("[ScheduledMessages] sender failed", error));
    const initial = setTimeout(run, 5_000);
    workerTimer = setInterval(run, 15_000);
    ProcessLifecycle.eventEmitter.once("stopping", async () => {
        stopping = true;
        clearTimeout(initial);
        clearInterval(workerTimer);
        await Promise.allSettled(sendingDue ? [sendingDue] : []);
    });
    return workerTimer;
}
