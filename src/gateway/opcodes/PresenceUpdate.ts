import { Session } from "@spacebar/database";
import { WebSocket, Payload } from "@spacebar/gateway";
import { broadcastPresence, emitSessionsReplace, sanitizeActivities } from "@spacebar/util";
import { ActivitySchema, PrivateStatus } from "@spacebar/schemas";
import { check } from "./instanceOf";
import { hasActivityWindow, recordActivity } from "@spacebar/api/util/utility/activity";
import { ProcessLifecycle } from "@spacebar/util/util/ProcessLifecycle";

const SettableStatuses = ["online", "idle", "dnd", "invisible"];
const PresenceWindow = 20_000;
const PresenceLimit = 5;
const pendingPresences = new Set<WebSocket>();
const activePresences = new Set<Promise<void>>();
let stopping = false;
const shutdownRequested = () => stopping || ProcessLifecycle.shutdownRequested;

export function cancelPendingPresence(socket: WebSocket) {
    clearTimeout(socket.presenceTimer);
    socket.presenceTimer = undefined;
    pendingPresences.delete(socket);
}

ProcessLifecycle.eventEmitter.on("stopping", async () => {
    stopping = true;
    for (const socket of pendingPresences) cancelPendingPresence(socket);
    await Promise.allSettled(activePresences);
});

export async function onPresenceUpdate(this: WebSocket, { d }: Payload) {
    if (shutdownRequested()) return;
    check.call(this, ActivitySchema, d);
    const presence = d as ActivitySchema;
    if (!this.session) return;

    const previous = JSON.stringify([this.session.status, this.session.activities, this.session.client_status]);

    if (SettableStatuses.includes(presence.status)) this.session.status = presence.status as PrivateStatus;
    this.session.activities = sanitizeActivities(presence.activities, this.session.activities);
    const platform = this.session.client_info?.platform ?? "web";
    this.session.client_status = this.session.status === "invisible" ? {} : { [platform]: this.session.status };
    this.session.last_seen = new Date();

    if (previous === JSON.stringify([this.session.status, this.session.activities, this.session.client_status])) return;

    const now = Date.now();
    this.presenceHistory = (this.presenceHistory ?? []).filter((time) => now - time < PresenceWindow);
    if (this.presenceHistory.length >= PresenceLimit) {
        this.presenceTimer ??= setTimeout(
            () => {
                cancelPendingPresence(this);
                if (shutdownRequested() || this.readyState !== this.OPEN) return;
                this.presenceHistory = [...(this.presenceHistory ?? []), Date.now()];
                savePresence.call(this).catch((e) => console.error(`[Gateway/${this.user_id}] failed to save throttled presence`, e));
            },
            PresenceWindow - (now - this.presenceHistory[0]),
        ).unref();
        pendingPresences.add(this);
        return;
    }
    cancelPendingPresence(this);
    this.presenceHistory.push(now);
    await savePresence.call(this);
}

function savePresence(this: WebSocket): Promise<void> {
    if (shutdownRequested() || !this.session) return Promise.resolve();
    const work = savePresenceOnce.call(this).finally(() => activePresences.delete(work));
    activePresences.add(work);
    return work;
}

async function savePresenceOnce(this: WebSocket) {
    if (!this.session) return;
    await Session.update(
        { session_id: this.session.session_id },
        {
            status: this.session.status,
            activities: this.session.activities,
            client_status: this.session.client_status,
            last_seen: this.session.last_seen,
        },
    );
    if (hasActivityWindow(this.user_id) || this.session.activities?.some((activity) => activity.type === 0))
        recordActivity(this.user_id).catch((error) => console.error("[Activity] presence update failed", error));
    await broadcastPresence(this.user_id);
    // Your own sessions list is how your client learns the status of each of your devices (the platform indicators on
    // your own profile read it), and it only changes when the server sends it again.
    await emitSessionsReplace(this.user_id);
}
