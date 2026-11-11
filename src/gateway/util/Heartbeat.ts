import { CLOSECODES } from "./Constants";
import { WebSocket } from "./WebSocket";

// TODO: make heartbeat timeout configurable
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;

export function setHeartbeat(socket: WebSocket) {
    if (socket.heartbeatTimeout)
        clearTimeout(socket.heartbeatTimeout);

    socket.heartbeatTimeout = setTimeout(
        () => socket.close(CLOSECODES.Session_timed_out),
        HEARTBEAT_TIMEOUT_MS
    );
}
