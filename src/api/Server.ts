import path from "node:path";
import { Request, Response, Router } from "express";
import morgan from "morgan";
import { Server, ServerOptions } from "lambert-server/Server";
import { red } from "picocolors";
import { FederatedObject, getDatabase, GuildInsights, initDatabase, ScheduledEvents } from "@spacebar/database";
import {
    Config,
    ConnectionConfig,
    ConnectionLoader,
    Email,
    JSONReplacer,
    WebAuthn,
    initEvent,
    onEmitEvent,
    registerRoutes,
    getRevInfoOrFail,
    JwtKeypairManager,
    FederationKey,
    ASSETS_FOLDER,
    PUBLIC_ASSETS_FOLDER,
    useClientAddress,
} from "@spacebar/util";
import { ProcessLifecycle, SystemdLifecycle } from "../util/util/ProcessLifecycle";
import { outboundProxyStatus } from "../util/util/networking/SocksTransport";
import { Monitoring } from "../util/monitoring/Monitoring";
import { BcryptWorkerPool } from "../util/util/workers/bcrypt/BcryptWorkerPool";
import { Authentication, CORS, ExternalProxy, ImageProxy, KlipyProxy, BodyParser, ErrorHandler, initRateLimits, initTopLevelRateLimits, initTranslation } from "./middlewares";
import { normalizeRequestPath } from "./middlewares/NormalizeRequestPath";
import { initInstance } from "./util/handlers/Instance";
import { initEmbeddedActivities } from "./activities";
import {
    recoverPendingPolls,
    dispatchMessagePush,
    startAttachmentFileSweeper,
    startCloudUploadSweeper,
    startImageFileSweeper,
    startMessagePurger,
    startScheduledMessageSender,
    startThreadArchiver,
} from "./util";
import { route } from "@spacebar/api/middlewares";
import { startAnnouncementDeliveryWorker } from "./util/utility/announcementDelivery";
import { startFederation } from "./util/utility/federation";
import { startDiscoveryIndexer } from "./util/handlers/Discovery";
import { startScamListRefresh } from "./util/utility/scamGuard";
import { forwardEvent, startFederationDelivery } from "./util/utility/federationEvents";
import { authorshipCutoff } from "./util/utility/federationAuthorship";
import { homeRelay } from "./util/utility/federationRelay";
import { startFederatedVoice } from "./util/utility/federationVoice";
import { federationGate, instanceBaseUrl, trustFor } from "./util/utility/federationNetwork";
import { setInstanceResolver, setRemoteLookup } from "./util/utility/federationMedia";
import { GifProviderManager } from "@spacebar/integrations/gifs";

export type SpacebarServerOptions = ServerOptions;

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            server: SpacebarServer;
        }
    }
}

export class SpacebarServer extends Server {
    declare public options: SpacebarServerOptions;

    constructor(opts?: Partial<SpacebarServerOptions>) {
        super(opts);
    }

    async mount() {
        this.app.use(normalizeRequestPath);
        this.app.set("json replacer", JSONReplacer);
        this.app.disable("x-powered-by");

        useClientAddress(this.app, () => Config.get().security);

        this.app.use(CORS);
        this.app.use("/federation/v2", federationGate);
        this.app.use(BodyParser({ inflate: true, limit: "10mb" }));
        this.app.use(Authentication);

        const app = this.app;
        const api = Router({ mergeParams: true });

        await initRateLimits(api);
        initTopLevelRateLimits(this.app);
        await initTranslation(api);
        api.use(homeRelay);

        this.routes = [
            ...(await registerRoutes(this, path.join(__dirname, "routes", "/"), api)),
            ...(await registerRoutes(this, path.join(__dirname, "routes_toplevel", "/"))),
        ].filter((r) => !!r);

        // 404 is not an error in express, so this should not be an error middleware
        // this is a fine place to put the 404 handler because its after we register the routes
        // and since its not an error middleware, our error handler below still works.
        // Emma [it/its] @ Rory& - the _ is required now, as pillarjs throw an error if you don't pass a param name now
        api.use("*_", (req: Request, res: Response) => {
            res.status(404).json({
                message: "Endpoint not found",
                code: 404,
                request: `${req.method} ${req.url}`,
            });
        });

        //app.use("/__development", )
        //app.use("/__internals", )

        app.use("/api/v6", api);
        app.use("/api/v7", api);
        app.use("/api/v8", api);
        app.use("/api/v9", api);
        app.use("/api/v10", api); // https://discord.com/developers/docs/change-log#api-v10
        app.use("/api", api); // allow unversioned requests

        app.use("/imageproxy/:hash/:size/:url", ImageProxy);
        app.get("/external/:hash/{*path}", ExternalProxy);
        app.get("/klipy/{*path}", KlipyProxy);

        this.app.use(ErrorHandler);
    }

    async start() {
        await Monitoring.init();
        Monitoring.attach(this.app);
        await initDatabase();
        await Config.init();
        await initEvent();
        onEmitEvent((payload) => (payload.event === "MESSAGE_CREATE" && payload.channel_id ? dispatchMessagePush(payload.data) : undefined));
        onEmitEvent(forwardEvent);
        await Email.init();
        await ConnectionConfig.init();
        await initInstance();
        await initEmbeddedActivities();
        await JwtKeypairManager.init();
        FederationKey.init();
        WebAuthn.init();
        // await BcryptWorkerPool.Init(8); // TODO: make configurable
        await GifProviderManager.init();
        ScheduledEvents.startSweeper();

        const logRequests = process.env["LOG_REQUESTS"] != undefined;
        if (logRequests && !this.options.app) {
            this.app.use(
                morgan("combined", {
                    skip: (req, res) => {
                        let skip = !(process.env["LOG_REQUESTS"]?.includes(res.statusCode.toString()) ?? false);
                        if (process.env["LOG_REQUESTS"]?.charAt(0) == "-") skip = !skip;
                        return skip;
                    },
                }),
            );
        }

        await this.mount();
        await recoverPendingPolls();

        await ConnectionLoader.loadConnections();

        const outbound = outboundProxyStatus();
        if (outbound.problem) console.warn(red(`[Network] Warning: ${outbound.problem}. See docs/self-hosting/external-services.md#hiding-the-servers-address`));
        if (logRequests) console.log(red(`Warning: Request logging is enabled! This will spam your console!\nTo disable this, unset the 'LOG_REQUESTS' environment variable!`));

        await super.start();
        startThreadArchiver();
        startScheduledMessageSender();
        startMessagePurger();
        startAttachmentFileSweeper();
        startImageFileSweeper();
        startCloudUploadSweeper();
        startAnnouncementDeliveryWorker();
        startFederation();
        startDiscoveryIndexer();
        startScamListRefresh();
        startFederationDelivery();
        authorshipCutoff().catch((error) => console.warn("[Federation] Could not record when signed authorship started:", (error as Error).message));
        startFederatedVoice();
        setRemoteLookup(async (local_id) => {
            const row = await FederatedObject.findOne({ where: { local_id }, select: { canonical: true, instance: true } });
            return row ? { instance: row.instance, remoteId: row.canonical } : null;
        });
        setInstanceResolver(async (id) => ((await trustFor(id)) ? { id, url: instanceBaseUrl(id) } : null));
        GuildInsights.startRollups();
        await SystemdLifecycle.setStatus(`Listening on ${this.options.host}:${this.options.port}...`);
        await ProcessLifecycle.Ready();
    }
}
