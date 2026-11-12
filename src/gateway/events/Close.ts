import { Member, Session, VoiceChannels, VoiceState } from "@spacebar/database";
import { isFinalClose, releaseDispatchBuffers, WebSocket } from "@spacebar/gateway/util";
import { broadcastPresence, emitEvent, emitSessionsReplace, FederatedVoice, VoiceStateUpdateEvent } from "@spacebar/util";
import { ProcessLifecycle } from "@spacebar/util/util/ProcessLifecycle";
import { openConnections } from "./Connection";
import { hasActivityWindow, recordActivity } from "@spacebar/api/util/utility/activity";
import { cancelPendingPresence } from "../opcodes/PresenceUpdate";

const pendingOffline = new Map<ReturnType<typeof setTimeout>, () => Promise<void>>();
const activeOffline = new Set<Promise<void>>();
let stopping = false;

const trackOffline = (cleanup: () => Promise<void>) => {
    const work = Promise.resolve()
        .then(cleanup)
        .finally(() => activeOffline.delete(work));
    activeOffline.add(work);
    return work;
};

ProcessLifecycle.eventEmitter.on("stopping", async () => {
    stopping = true;
    for (const [timer, cleanup] of pendingOffline) {
        clearTimeout(timer);
        pendingOffline.delete(timer);
        trackOffline(cleanup);
    }
    await Promise.allSettled(activeOffline);
});

export async function Close(this: WebSocket, code: number, reason: Buffer) {
    console.log("[WebSocket] closed", code, reason.toString());
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    cancelPendingPresence(this);
    this.deflate?.close();
    this.inflate?.close();
    this.zstdEncoder?.destroy();
    this.removeAllListeners();
    if (!this.listenerCleanup) releaseDispatchBuffers(this);

    if (this.session) {
        const authSessionId = this.session?.session_id;
        const closedAt = Date.now();

        const markOffline = async () => {
            try {
                if (!authSessionId || !this.user_id) return;
                const s = await Session.findOne({
                    where: { user_id: this.user_id, session_id: authSessionId },
                });
                if (
                    !s ||
                    (s.last_seen?.getTime() ?? 0) > closedAt ||
                    openConnections.some((x) => x !== this && x.session?.session_id === authSessionId && x.user_id === this.user_id)
                )
                    return;
                await Session.update({ user_id: this.user_id, session_id: authSessionId }, { status: "offline", activities: [], client_status: {} });
                if (hasActivityWindow(this.user_id)) await recordActivity(this.user_id).catch((error) => console.error("[Activity] final update failed", error));
                await emitSessionsReplace(this.user_id);
                await broadcastPresence(this.user_id);
            } catch (e) {
                console.error("[WebSocket] Close session cleanup failed", code, e);
            }
        };

        if (stopping || ProcessLifecycle.state === "stopping" || ProcessLifecycle.state === "stopped") await trackOffline(markOffline);
        else {
            const timer = setTimeout(
                () => {
                    pendingOffline.delete(timer);
                    return trackOffline(markOffline);
                },
                isFinalClose(code) ? 0 : 10_000,
            ).unref();
            pendingOffline.set(timer, markOffline);
        }

        if (!this.user_id) console.error("No user id in websocket???", this);
        const voiceState = await VoiceState.findOne({
            where: { user_id: this.user_id },
        });

        // clear the voice state for this session if user was in voice channel
        const leftRemoteCall =
            voiceState?.session_id === this.session_id &&
            !!voiceState.channel_id &&
            (await FederatedVoice.relay(this.user_id, this.session_id, { guild_id: null, channel_id: null, self_mute: false, self_deaf: false }).catch((error) => {
                console.error("[Gateway] Could not leave a call on another instance:", error);
                return false;
            }));
        if (voiceState && voiceState.session_id === this.session_id && voiceState.channel_id && !leftRemoteCall) {
            const prevGuildId = voiceState.guild_id;
            const prevChannelId = voiceState.channel_id;
            const prevConnectedAt = voiceState.connected_at;

            // @ts-expect-error channel_id is nullable
            voiceState.channel_id = null;
            // @ts-expect-error guild_id is nullable
            voiceState.guild_id = null;
            voiceState.self_stream = false;
            voiceState.self_video = false;
            voiceState.connected_at = null;
            await voiceState.save();

            const member = prevGuildId
                ? await Member.findOne({
                      where: { id: voiceState.user_id, guild_id: prevGuildId },
                      relations: { user: true, roles: true },
                  })
                : null;
            await emitEvent({
                event: "VOICE_STATE_UPDATE",
                data: {
                    ...voiceState.toPublicVoiceState(),
                    guild_id: prevGuildId ?? null,
                    member: member?.toPublicMember(),
                },
                guild_id: prevGuildId ?? undefined,
                channel_id: prevGuildId ? undefined : prevChannelId,
            } satisfies VoiceStateUpdateEvent);
            await VoiceChannels.occupancyChanged(prevGuildId, prevChannelId, this.user_id, false, prevConnectedAt);
        }
    }
}
