import { Not } from "typeorm";
import { Config, emitEvent } from "@spacebar/util/util";
import { ProcessLifecycle } from "@spacebar/util/util/ProcessLifecycle";
import { Stream } from "../entities/Stream";
import { StreamSession } from "../entities/StreamSession";

export const StreamPreviews = new Map<string, string>();
const paused = new Set<string>();

export class GoLiveStreams {
    static isPaused(id: string) {
        return paused.has(id);
    }

    static key(stream: Stream) {
        const guildId = stream.channel?.guild_id;
        return guildId ? `guild:${guildId}:${stream.channel_id}:${stream.owner_id}` : `call:${stream.channel_id}:${stream.owner_id}`;
    }

    static region(stream: Stream) {
        return Config.get().regions.available.find((region) => region.endpoint === stream.endpoint)?.id ?? Config.get().regions.default;
    }

    static async viewers(stream: Stream) {
        const sessions = await StreamSession.find({
            where: { stream_id: stream.id, used: true, user_id: Not(stream.owner_id) },
        });
        return [...new Set(sessions.map((session) => session.user_id))];
    }

    static async publishUpdate(streamId: string, pausedState?: boolean) {
        const stream = await Stream.findOne({ where: { id: streamId }, relations: { channel: true } });
        if (!stream) return;
        if (pausedState !== undefined) {
            if (pausedState) paused.add(stream.id);
            else paused.delete(stream.id);
        }
        const viewerIds = await GoLiveStreams.viewers(stream);
        ProcessLifecycle.eventEmitter.emit("activityProgress", stream.owner_id);
        const data = {
            stream_key: GoLiveStreams.key(stream),
            region: GoLiveStreams.region(stream),
            viewer_ids: viewerIds,
            paused: paused.has(stream.id),
        };
        await Promise.all([stream.owner_id, ...viewerIds].map((userId) => emitEvent({ event: "STREAM_UPDATE", user_id: userId, data })));
    }

    static async end(ownerId: string, reason?: string) {
        const streams = await Stream.find({
            where: { owner_id: ownerId },
            relations: { channel: true },
        });
        for (const stream of streams) {
            const streamKey = GoLiveStreams.key(stream);
            StreamPreviews.delete(streamKey);
            paused.delete(stream.id);
            await stream.remove();
            ProcessLifecycle.eventEmitter.emit("activityProgress", ownerId);
            const guildId = stream.channel?.guild_id;
            await emitEvent({
                event: "STREAM_DELETE",
                guild_id: guildId ?? undefined,
                channel_id: guildId ? undefined : stream.channel_id,
                data: { stream_key: streamKey, reason },
            });
        }
    }
}
