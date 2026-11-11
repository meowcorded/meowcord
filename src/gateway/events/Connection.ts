/* eslint-disable @typescript-eslint/ban-ts-comment */
import WS from "ws";
import { clientAddress } from "../util/ClientAddress";
import { genSessionId, WebSocket } from "@spacebar/gateway";
import { Send } from "../util/Send";
import { CLOSECODES, OPCODES } from "../util/Constants";
import { HEARTBEAT_INTERVAL_MS, setHeartbeat } from "../util/Heartbeat";
import { IncomingMessage } from "node:http";
import { Close } from "./Close";
import { Message } from "./Message";
import { URL } from "node:url";
import { Config } from "@spacebar/util";
import { compressors } from "../util/Compression";
import { ProcessLifecycle } from "@spacebar/util/util/ProcessLifecycle";
import { Monitoring } from "../../util/monitoring/Monitoring";
import { Gauge } from "prom-client";
import { admitPendingConnection, settlePendingConnection } from "../util/PendingConnections";

// TODO: check rate limit
// TODO: specify rate limit in config
// TODO: check msg max size

export const openConnections: WebSocket[] = [];

const shutdownConnections = new Map<WebSocket, () => Promise<void>>();
ProcessLifecycle.eventEmitter.on("stopping", async () => {
    for (const shutdown of Array.from(shutdownConnections.values())) await shutdown();
});

const openConnectionCount = Monitoring.attachMetric(
    "spacebar_gateway_open_connection_count",
    new Gauge({
        name: "spacebar_gateway_open_connection_count",
        help: "The total number of HTTP requests received",
        registers: [],
    }),
);

export async function Connection(this: WS.Server, socket: WebSocket, request: IncomingMessage) {
    openConnections.push(socket);
    openConnectionCount.set(openConnections.length);
    socket.on("close", () => {
        settlePendingConnection(socket);
        shutdownConnections.delete(socket);
        const index = openConnections.indexOf(socket);
        if (index !== -1) openConnections.splice(index, 1);
        openConnectionCount.set(openConnections.length);
    });

    const onShutdown = async () => {
        await Send(socket, {
            op: OPCODES.Reconnect,
            s: socket.sequence++,
            d: Math.round(Math.random() * 5000),
        });

        const closeListeners = socket.listeners("close");
        for (const listener of closeListeners) {
            socket.off("close", listener);
            // noinspection JSVoidFunctionReturnValueUsed - awaiting results
            const res = listener.call(socket, 1000, Buffer.alloc(0)) as void | Promise<void>;
            if (res) await res;
        }

        socket.close(1000);
    };

    if (ProcessLifecycle.state == "stopping" || ProcessLifecycle.state == "stopped") return await onShutdown();
    shutdownConnections.set(socket, onShutdown);

    const { forwardedFor, trustedProxies } = Config.get().security;
    const ipAddress = clientAddress(request, forwardedFor, trustedProxies);

    socket.ipAddress = ipAddress;
    socket.userAgent = request.headers["user-agent"] as string;

    if (!admitPendingConnection(socket, ipAddress, Config.get().limits.gateway.pendingConnectionsPerIp))
        return socket.close(CLOSECODES.Rate_limited, "Too many connections are waiting to identify.");

    if (!ipAddress && Config.get().security.cdnSignatureIncludeIp) {
        console.error("Gateway connection rejected: No IP address found.");
        return socket.close(CLOSECODES.Decode_error, "Gateway connection rejected: IP address is required.");
    }

    if (request.headers.cookie?.split("; ").find((x) => x.startsWith("__sb_sessid="))) {
        socket.fingerprint = request.headers.cookie
            .split("; ")
            .find((x) => x.startsWith("__sb_sessid="))
            ?.split("=")[1];
    }

    //Create session ID when the connection is opened. This allows gateway dump to group the initial websocket messages with the rest of the conversation.
    socket.session_id = "TEMP_" + genSessionId(); //Set the session of the WebSocket object

    try {
        socket.on("close", (code, reason) => Close.call(socket, code, reason).catch((error) => console.error("[Gateway] Connection cleanup failed", error)));
        // @ts-ignore
        socket.on("message", Message);

        socket.on("error", (err) => console.error(`[Gateway/${socket.user_id ?? socket.ipAddress}]`, err));

        console.log(`[Gateway] New connection from ${ipAddress}, total ${this.clients.size}`);

        if (process.env.WS_LOGEVENTS)
            [
                "close",
                "error",
                "upgrade",
                //"message",
                "open",
                "ping",
                "pong",
                "unexpected-response",
            ].forEach((x) => {
                socket.on(x, (y) => console.log(x, y));
            });

        const { searchParams } = new URL(`http://localhost${request.url}`);
        // @ts-ignore
        socket.encoding = searchParams.get("encoding") || "json";
        if (!["json", "etf"].includes(socket.encoding)) {
            console.error(`[Gateway/${socket.ipAddress}] Unknown encoding: ${socket.encoding}`);
            return socket.close(CLOSECODES.Decode_error);
        }

        socket.version = Number(searchParams.get("v") ?? searchParams.get("version") ?? "8");
        if (![8, 9, 10].includes(socket.version)) {
            console.error(`[Gateway/${socket.ipAddress}] Invalid API version: ${socket.version}`);
            return socket.close(CLOSECODES.Invalid_API_version);
        }

        // @ts-ignore
        socket.compress = searchParams.get("compress") || "";
        if (socket.compress) {
            if (socket.compress === "zlib-stream") {
                socket.deflate = compressors.deflate();
            } else if (socket.compress === "zstd-stream") {
                socket.zstdEncoder = compressors.zstd();
                if (!socket.zstdEncoder) return socket.close(CLOSECODES.Decode_error, "zstd-stream is not supported here, use zlib-stream.");
            } else {
                console.error(`[Gateway/${socket.user_id}] Unknown compression: ${socket.compress}`);
                return socket.close(CLOSECODES.Decode_error);
            }
        }

        socket.recentTransactions = [];
        socket.events = {};
        socket.member_events = {};
        socket.permissions = {};
        socket.sequence = 0;

        setHeartbeat(socket);

        await Send(socket, {
            op: OPCODES.Hello,
            d: {
                heartbeat_interval: HEARTBEAT_INTERVAL_MS,
            },
        });

        socket.readyTimeout = setTimeout(() => socket.close(CLOSECODES.Session_timed_out), 1000 * 30);
    } catch (error) {
        console.error(error);
        return socket.close(CLOSECODES.Unknown_error);
    }
}
