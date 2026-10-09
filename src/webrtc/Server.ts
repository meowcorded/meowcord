import http from "node:http";
import type { Duplex } from "node:stream";
import ws from "ws";
import { green, yellow } from "picocolors";
import { initDatabase } from "@spacebar/database";
import { Config, initEvent, JwtKeypairManager, VoiceHealth } from "@spacebar/util";
import { ProcessLifecycle, SystemdLifecycle } from "../util/util/ProcessLifecycle";
import { Monitoring } from "../util/monitoring/Monitoring";
import { Connection } from "./events/Connection";
import { DaveSession } from "./dave/DaveSession";
import { AfkMover } from "./util/AfkMover";
import { loadWebRtcLibrary, mediaServer, resolvePublicIp, WRTC_PORT_MAX, WRTC_PORT_MIN, WRTC_PUBLIC_IP, WebRtcWebSocket } from "./util";
import { PionMediaServer } from "./pion/PionMediaServer";

export class WebrtcServer {
    public ws: ws.Server;
    public port: number;
    public server: http.Server;
    public production: boolean;

    // when set there's no listener of our own: whoever owns the http server hands upgrades to handleUpgrade
    public readonly noServer: boolean;

    constructor({
        port,
        server,
        production,
        noServer,
    }: {
        port: number;
        server?: http.Server;
        production?: boolean;
        noServer?: boolean;
    }) {
        this.port = port;
        this.production = production || false;
        this.noServer = noServer ?? false;

        if (server) this.server = server;
        else {
            this.server = http.createServer(async (req, res) => {
                const requestUrl = new URL(`http://${req.headers.host}${req.url}`);
                if (requestUrl.pathname === "/metrics") {
                    return await Monitoring.handleRawRequest(req, res);
                } else res.writeHead(200).end("Online");
            });
        }

        // this.server.on("upgrade", (request, socket, head) => {
        // 	if (!request.url?.includes("voice")) return;
        // 	this.ws.handleUpgrade(request, socket, head, (socket) => {
        // 		// @ts-expect-error
        // 		socket.server = this;
        // 		this.ws.emit("connection", socket, request);
        // 	});
        // });

        this.ws = new ws.Server({
            maxPayload: 1024 * 1024,
            verifyClient: ({ req }: { req: import("node:http").IncomingMessage }) => {
                if (this.ws.clients.size >= 2048) return false;
                const address = req.socket.remoteAddress;
                let connections = 0;
                for (const client of this.ws.clients) {
                    if ((client as WebRtcWebSocket).remoteAddress === address) connections++;
                }
                return connections < 64;
            },
            ...(this.noServer ? { noServer: true } : { server: this.server }),
        });
        this.ws.on("connection", Connection);
        this.ws.on("error", console.error);
    }

    async start(): Promise<void> {
        await Monitoring.init();
        await initDatabase();
        await Config.init();
        await initEvent();
        await JwtKeypairManager.init();

        // try to load webrtc library, if failed just don't start webrtc endpoint
        try {
            await loadWebRtcLibrary();
            await mediaServer.start(await resolvePublicIp(WRTC_PUBLIC_IP), WRTC_PORT_MIN, WRTC_PORT_MAX);
            AfkMover.start();
            DaveSession.onTransitionExecuted((roomId) => {
                for (const delay of [300, 1500])
                    setTimeout(() => {
                        for (const client of mediaServer.getClientsForRtcServer(roomId)) (client as { requestKeyframe?: () => void }).requestKeyframe?.();
                    }, delay);
            });
        } catch (e) {
            console.log(`[WebRTC] ${yellow("WEBRTC disabled")}`);
            const reason = e instanceof Error ? e.message : "No WebRTC library is configured, or it failed to load or connect";
            VoiceHealth.register(async () => ({
                enabled: false,
                library: process.env.WRTC_LIBRARY ?? null,
                reason,
            }));
            return;
        }

        const startedAt = new Date().toISOString();
        const library = mediaServer instanceof PionMediaServer ? "pion" : (process.env.WRTC_LIBRARY ?? "unknown");
        VoiceHealth.register(async () => ({
            enabled: true,
            library,
            started_at: startedAt,
            listen: this.noServer ? "/voice on the main port" : `0.0.0.0:${this.port}`,
            ...(mediaServer instanceof PionMediaServer ? await mediaServer.health() : {}),
            dave_sessions: DaveSession.count(),
        }));

        if (!this.noServer && !this.server.listening) {
            this.server.listen(this.port);
            console.log(`[WebRTC] ${green(`online on 0.0.0.0:${this.port}`)}`);
            await SystemdLifecycle.setStatus(`Listening on 0.0.0.0:${this.port}...`);
        }

        await ProcessLifecycle.Ready();
    }

    handleUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
        this.ws.handleUpgrade(request, socket, head, (socket) => this.ws.emit("connection", socket, request));
    }

    async stop() {
        await ProcessLifecycle.Shutdown();
        AfkMover.stop();
        if (!this.noServer) this.server.close();
        await mediaServer?.stop();
        await ProcessLifecycle.Finalize();
    }
}
