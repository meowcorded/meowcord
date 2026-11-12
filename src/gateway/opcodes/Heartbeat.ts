import { FindOptionsWhere } from "typeorm";
import { OPCODES, Payload, WebSocket } from "@spacebar/gateway";
import { Session } from "@spacebar/database";
import { broadcastPresence, PRESENCE_STALE_AFTER_MS } from "@spacebar/util";
import { setHeartbeat } from "../util/Heartbeat";
import { Send } from "../util/Send";
import { hasActivityWindow, recordActivity } from "@spacebar/api/util/utility/activity";

interface QoSData {
    seq: number | null;
    qos: QoSPayload;
}

export interface QoSPayload {
    ver: number;
    active: boolean;
    reasons: string[];
}

const LastSeenInterval = 60_000;

export async function onHeartbeat(this: WebSocket, data: Payload) {
    // TODO: validate payload

    setHeartbeat(this);

    if (data.op === OPCODES.SetQoS) {
        this.qos = (data.d as QoSData).qos;
    }

    await Send(this, { op: 11, d: {} });
    const now = Date.now();
    if (this.session && now - (this.lastSeenWrite ?? 0) >= LastSeenInterval) {
        const lapsed = now - (this.lastSeenWrite ?? this.session.last_seen?.getTime() ?? now) > PRESENCE_STALE_AFTER_MS;
        this.lastSeenWrite = now;
        const { status, activities, client_status } = this.session;
        Session.update({ session_id: this.session.session_id, user_id: this.user_id } as FindOptionsWhere<Session>, {
            last_seen: new Date(),
            ...(lapsed && { status, activities, client_status }),
        })
            .then(() => {
                if (hasActivityWindow(this.user_id) || activities?.some((activity) => activity.type === 0))
                    recordActivity(this.user_id).catch((error) => console.error("[Activity] heartbeat update failed", error));
                return lapsed && status !== "offline" ? broadcastPresence(this.user_id) : undefined;
            })
            .catch((e) => console.error(`[Gateway/${this.user_id}] failed to record heartbeat`, e));
    }
}
