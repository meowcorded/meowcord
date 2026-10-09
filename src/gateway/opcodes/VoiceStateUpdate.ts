import { Channel, Guild, Member, Recipient, Relationship, User, VoiceChannels, VoiceState } from "@spacebar/database";
import { Payload, WebSocket, genVoiceToken } from "@spacebar/gateway";
import { Config, emitEvent, getPermission, requiredAction, VoiceServerUpdateEvent, VoiceStateUpdateEvent } from "@spacebar/util";
import { ChannelType, ConfigVoiceRegion, VoiceStateUpdateSchema } from "@spacebar/schemas";
import { check } from "./instanceOf";

const VOICE_TYPES = [ChannelType.GUILD_VOICE, ChannelType.GUILD_STAGE_VOICE, ChannelType.DM, ChannelType.GROUP_DM];

async function awaitsVerification(userId: string) {
    if (!Config.get().login.requireVerification) return false;
    const user = await User.findOne({ where: { id: userId }, select: { id: true, bot: true, verified: true } });
    return !!user && requiredAction(user) !== null;
}

async function canJoin(userId: string, guildId: string | undefined, channelId: string, currentChannelId?: string) {
    if (await awaitsVerification(userId)) return null;
    const channel = await Channel.findOne({
        where: { id: channelId },
        select: { id: true, type: true, guild_id: true, user_limit: true, permission_overwrites: true },
    });
    if (!channel || !VOICE_TYPES.includes(channel.type)) return null;
    if (!channel.guild_id) {
        const recipients = await Recipient.find({
            where: { channel_id: channelId },
            select: { user_id: true },
        });
        if (!recipients.some((x) => x.user_id === userId)) return null;
        // no calls in a dm between people where one blocked the other
        const other = channel.type === ChannelType.DM ? recipients.find((x) => x.user_id !== userId)?.user_id : undefined;
        if (other && (await Relationship.isBlockedBetween(userId, other))) return null;
        return channel;
    }
    if (channel.guild_id !== guildId) return null;

    const permissions = await getPermission(userId, channel.guild_id, channelId);
    if (!permissions.has("VIEW_CHANNEL") || !permissions.has("CONNECT")) return null;
    if (channel.user_limit && currentChannelId !== channelId && !permissions.has("MOVE_MEMBERS")) {
        const count = await VoiceState.count({ where: { channel_id: channelId } });
        if (count >= channel.user_limit) return null;
    }
    return channel;
}

export async function onVoiceStateUpdate(this: WebSocket, data: Payload) {
    const startTime = Date.now();
    check.call(this, VoiceStateUpdateSchema, data.d);
    const body = data.d as VoiceStateUpdateSchema;
    const guildId = body.guild_id ?? undefined;
    const channelId = body.channel_id ?? undefined;

    let voiceState = await VoiceState.findOne({ where: { user_id: this.user_id } });
    if (voiceState && voiceState.session_id !== this.session_id && !channelId) return;

    const previous = voiceState
        ? {
              guild_id: voiceState.guild_id,
              channel_id: voiceState.channel_id,
              connected_at: voiceState.connected_at,
          }
        : { guild_id: undefined, channel_id: undefined, connected_at: undefined };
    const channel = channelId ? await canJoin(this.user_id, guildId, channelId, previous.channel_id) : null;
    if (channelId && !channel) return;

    const member = channel?.guild_id
        ? await Member.findOne({
              where: { id: this.user_id, guild_id: channel.guild_id },
              relations: { user: true, roles: true },
          })
        : null;
    const channelChanged = previous.channel_id !== (channelId ?? null) || (voiceState?.session_id !== this.session_id && !!channelId);

    if (previous.guild_id && previous.channel_id && channelChanged && voiceState && (!channelId || previous.guild_id !== channel?.guild_id)) {
        const previousMember = await Member.findOne({
            where: { id: this.user_id, guild_id: previous.guild_id },
            relations: { user: true, roles: true },
        });
        await emitEvent({
            event: "VOICE_STATE_UPDATE",
            data: {
                ...voiceState.toPublicVoiceState(),
                channel_id: null,
                self_stream: false,
                self_video: false,
                member: previousMember?.toPublicMember(),
            },
            guild_id: previous.guild_id,
        } satisfies VoiceStateUpdateEvent);
    } else if (!previous.guild_id && previous.channel_id && channelChanged && voiceState && previous.channel_id !== channelId) {
        await emitEvent({
            event: "VOICE_STATE_UPDATE",
            data: {
                ...voiceState.toPublicVoiceState(),
                channel_id: null,
                guild_id: null,
                self_stream: false,
                self_video: false,
            },
            channel_id: previous.channel_id,
        } satisfies VoiceStateUpdateEvent);
    }

    if (!voiceState)
        voiceState = VoiceState.create({
            user_id: this.user_id,
            deaf: false,
            mute: false,
            suppress: false,
            self_video: false,
        });

    if (voiceState.session_id !== this.session_id) voiceState.token = genVoiceToken();
    voiceState.session_id = this.session_id;
    voiceState.guild_id = (channel?.guild_id ?? null) as string;
    voiceState.channel_id = (channelId ?? null) as string;
    voiceState.self_mute = body.self_mute;
    voiceState.self_deaf = body.self_deaf;
    voiceState.self_video = channelId ? (body.self_video ?? false) : false;
    if (!channelId) voiceState.self_stream = false;
    if (channelChanged) {
        voiceState.connected_at = channelId ? Math.floor(Date.now() / 1000) : null;
        voiceState.mute = member?.mute ?? false;
        voiceState.deaf = member?.deaf ?? false;
        voiceState.suppress = channel?.type === ChannelType.GUILD_STAGE_VOICE;
        voiceState.request_to_speak_timestamp = null as unknown as undefined;
        voiceState.self_stream = false;
    }
    await voiceState.save();

    if (channelId) {
        await emitEvent({
            event: "VOICE_STATE_UPDATE",
            data: { ...voiceState.toPublicVoiceState(), member: member?.toPublicMember() },
            guild_id: channel?.guild_id ?? undefined,
            channel_id: channel?.guild_id ? undefined : channelId,
        } satisfies VoiceStateUpdateEvent);
    } else if (!previous.channel_id) {
        await emitEvent({
            event: "VOICE_STATE_UPDATE",
            data: voiceState.toPublicVoiceState(),
            user_id: this.user_id,
        } satisfies VoiceStateUpdateEvent);
    }

    if (channelChanged) {
        if (previous.channel_id) await VoiceChannels.occupancyChanged(previous.guild_id, previous.channel_id, this.user_id, false, previous.connected_at);
        if (channelId) await VoiceChannels.occupancyChanged(channel?.guild_id, channelId, this.user_id, true);
    }

    if (channelChanged && channelId) {
        const guild = channel?.guild_id ? await Guild.findOne({ where: { id: channel.guild_id }, select: { id: true, region: true } }) : null;
        const regions = Config.get().regions;
        const defaultRegion = regions.available.find((r) => r.id === regions.default);
        const guildRegion: ConfigVoiceRegion | undefined = (guild?.region ? regions.available.find((r) => r.id === guild.region) : undefined) ?? defaultRegion;
        if (!guildRegion) throw new Error("Unable to find suitable region due to misconfiguration of regions");

        await emitEvent({
            event: "VOICE_SERVER_UPDATE",
            data: {
                token: voiceState.token,
                guild_id: channel?.guild_id ?? null,
                channel_id: channel?.guild_id ? undefined : channelId,
                endpoint: guildRegion.endpoint,
            },
            user_id: this.user_id,
        } satisfies VoiceServerUpdateEvent);
    }

    console.log(
        `[Gateway/${this.user_id}] VOICE_STATE_UPDATE for user ${this.user_id} in channel ${voiceState.channel_id} in guild ${voiceState.guild_id} in ${Date.now() - startTime}ms`,
    );
}
