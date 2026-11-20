import { VoicePayload, WebRtcWebSocket } from "../util";
import { tokenEquals } from "@spacebar/api/util/utility/tokenEquals";
import { VoiceSessions } from "../util/VoiceSessions";

export async function onResume(this: WebRtcWebSocket, data: VoicePayload) {
    if (this.user_id) return this.close(4005, "Already authenticated");

    const { server_id, session_id, token, seq_ack } = (data.d ?? {}) as {
        server_id?: string;
        session_id?: string;
        token?: string;
        seq_ack?: number;
    };
    const previous = VoiceSessions.find(server_id, session_id);
    if (!previous || !tokenEquals(token, previous.token) || previous.sessionEnded || previous.resumedBy || !previous.webRtcClient)
        return this.close(4006, "Session no longer valid");
    if (previous.federation?.sender !== this.federation?.sender) return this.close(4006, "Session no longer valid");
    if (!(await VoiceSessions.isValid(previous))) {
        await VoiceSessions.end(previous);
        return this.close(4006, "Session no longer valid");
    }

    const replayed = await VoiceSessions.resume(this, previous, typeof seq_ack === "number" ? seq_ack : -1);
    if (replayed === null) return this.close(4006, "Session no longer valid");
    console.log(`[WebRTC] ${this.user_id} resumed voice session ${session_id} on ${server_id} after seq ${seq_ack ?? "none"}, replayed ${replayed} messages`);
}
