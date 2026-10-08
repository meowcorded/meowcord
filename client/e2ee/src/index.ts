import { createAttachments } from "./attachments";
import { randomBytes, toB64u } from "./bytes";
import { aesDecrypt, aesEncrypt, exportPublic, generateAgreementKey, generateSigningKey, hpkeOpen, hpkeSeal, sign, verify } from "./crypto";
import { Api, Engine } from "./engine";
import { createHooks, MessageState } from "./hooks";
import { createLink, LinkEvent } from "./link";
import { createUi } from "./ui";
import { StickerMeta } from "./files";
import { browserStorage } from "./store";
import { findStore, HttpClient, scan, Targets } from "./webpack";
import { locale, t } from "./i18n";

interface LoaderState {
    reqs: { c?: Record<string, { exports: unknown }> }[];
    status?: () => unknown;
    isEncrypted?: (channelId: string) => boolean;
    beforeSend?: (channelId: string) => boolean | Promise<boolean>;
    mountSettings?: (container: HTMLElement) => () => void;
    openSettings?: () => void;
    updateMessage?: (channelId: string, messageId: string, fields: Record<string, unknown>) => void;
}

declare global {
    interface Window {
        __fosscordE2ee?: LoaderState;
    }
}

const HOOK_TIMEOUT_MS = 20000;

const loader: LoaderState = (window.__fosscordE2ee ??= { reqs: [] });
const states = new Map<string, { state: MessageState; reason?: string }>();
const targets: Targets = {};
let http: HttpClient | null = null;
let failure: string | null = null;
let settle: (ok: boolean) => void = () => {};
const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
});
let started = false;
let initialized = false;
let signedOut = false;
let lastProbe = -Infinity;
let probing = false;

const api: Api = {
    async request<T>(method: "get" | "post" | "put" | "patch" | "del", url: string, body?: unknown) {
        if (!http) throw new Error("HTTP client not found");
        if (signedOut) throw { ok: false, status: 401, body: { message: "This session was signed out" } };
        const requestingUser = engine.userId;
        const res = await http[method]({
            url,
            body,
            rejectWithError: false,
            timeout: 15000,
            retries: 0,
        }).catch((error: unknown) => {
            if ((error as { status?: number } | null)?.status === 401 && requestingUser && requestingUser === engine.userId) sessionEnded();
            throw error;
        });
        if (res.status === 401 && requestingUser && requestingUser === engine.userId) sessionEnded();
        if (!res.ok) throw res;
        return res.body as T;
    },
};

interface NativeChannelStore {
    getChannel(id: string): { type?: number; e2ee_enabled?: boolean } | undefined;
}
let nativeChannels: NativeChannelStore | null = null;
const classifyChannel = (channelId: string) => {
    nativeChannels ??= findStore<NativeChannelStore>(loader.reqs, ["getChannel", "getDMFromUserId"]);
    const channel = nativeChannels?.getChannel(channelId);
    if (channel?.e2ee_enabled) return true;
    return channel ? channel.type === 1 || channel.type === 3 : location.pathname === `/channels/@me/${channelId}`;
};
const trustsServer = () =>
    (window as unknown as { GLOBAL_ENV?: { E2EE_TRUST_SERVER?: boolean } }).GLOBAL_ENV?.E2EE_TRUST_SERVER !== false &&
    browserStorage?.getItem("fosscord-e2ee-strict-safety") !== "true";
const engine = new Engine(api, classifyChannel, trustsServer);
const attachments = createAttachments();
attachments.start();

interface StickerStore {
    getStickerById(id: string): { id: string; name?: string; format_type?: number } | undefined;
}

let stickerStore: StickerStore | null = null;
const sticker = (id: string): StickerMeta | null => {
    stickerStore ??= findStore<StickerStore>(loader.reqs, ["getStickerById", "getStickerPack"]);
    const found = stickerStore?.getStickerById(id);
    return found ? { id, name: String(found.name ?? ""), format_type: Number(found.format_type ?? 1) } : null;
};

const apiBase = () => {
    const env = (window as unknown as { GLOBAL_ENV?: { API_ENDPOINT?: string; API_VERSION?: number } }).GLOBAL_ENV;
    return `${env?.API_ENDPOINT ?? "/api"}/v${env?.API_VERSION ?? 9}`;
};

const storedToken = () => {
    try {
        const value = JSON.parse(browserStorage?.getItem("token") ?? "null") as unknown;
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
};

const link = createLink(engine, api, {
    onPrompt: (prompt) => {
        if (!engine.trustsServer) ui.showApproval(prompt);
        else if (prompt.autoApprove) prompt.approve().catch((error) => console.error("[e2ee] automatic browser linking failed", error));
    },
    onChange: () => ui.renderUnlock(),
    onDismiss: (requestId) => ui.dismissApproval(requestId),
    onPeerUnlock: () => {
        if (initialized && !signedOut && engine.locked) engine.refresh().catch((error) => console.error("[e2ee] refresh failed", error));
    },
    onPeerReset: () => {
        if (initialized && !signedOut) engine.refresh().catch((error) => console.error("[e2ee] refresh failed", error));
    },
    beacon: (body) => {
        const token = storedToken();
        if (!token) return;
        fetch(`${apiBase()}/users/@me/e2ee/link`, {
            method: "POST",
            keepalive: true,
            headers: { "content-type": "application/json", authorization: token },
            body: JSON.stringify(body),
        }).catch(() => {});
    },
});

const tokenApi = (token: string): Api => ({
    async request<T>(method: "get" | "post" | "put" | "patch" | "del", url: string, body?: unknown) {
        const res = await fetch(`${apiBase()}${url}`, {
            method: method === "del" ? "DELETE" : method.toUpperCase(),
            headers: { "content-type": "application/json", authorization: token },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const parsed = await res.json().catch(() => null);
        if (!res.ok) throw { ok: false, status: res.status, body: parsed };
        return parsed as T;
    },
});

const verifyPassword = async (password: string) => {
    try {
        await api.request("post", "/users/@me/e2ee/password", { password });
        return true;
    } catch (error) {
        if ((error as { status?: number })?.status === 400) return false;
        throw error;
    }
};

const ui = createUi({
    engine,
    ready,
    states,
    link,
    verifyPassword,
    reset: (password) => engine.reset(password),
    enableChannel: async (channelId) => {
        await api.request("put", `/channels/${channelId}/e2ee`, { enabled: true });
        engine.setChannelEncrypted(channelId);
    },
});

function sessionEnded() {
    if (signedOut) return;
    signedOut = true;
    console.warn("[e2ee] this tab's session isn't valid anymore, so it stops handling encryption");
    link.stop();
}
const describeError = (error: unknown) => {
    if (error instanceof Error) return error.message;
    const response = error as { status?: unknown; body?: { message?: unknown } } | null;
    if (typeof response?.status !== "number") return String(error);
    return `HTTP ${response.status}${typeof response.body?.message === "string" ? ` ${response.body.message}` : ""}`;
};

const fail = (reason: string) => {
    if (failure) return;
    failure = reason;
    console.error(`[e2ee] ${reason}`);
    ui.fail(t("End-to-end encryption is unavailable in this client build, so sending in encrypted conversations is turned off."));
    settle(false);
};

let readyNow = false;
ready.then((ok) => {
    readyNow = ok;
    if (ok) hooks.retryAll();
});

const hooks = createHooks({
    fetchEmbeds: async (urls) => (await api.request<{ embeds: Record<string, unknown[]> }>("post", "/e2ee/embeds", { urls })).embeds ?? {},
    fetchSoundmoji: async (refs) => (await api.request<{ sounds: unknown[] }>("post", "/e2ee/soundmoji", { refs })).sounds ?? [],
    engine,
    attachments,
    sticker,
    ready,
    states,
    failClosed: () => failure !== null,
    isReady: () => readyNow,
    onLogout: () => {
        loggedOut = true;
        link.stop();
        engine.forget().catch((error) => console.error("[e2ee] couldn't remove this browser's keys", error));
    },
    onCredentials: (path, body, response) => {
        const password = typeof body.password === "string" ? body.password : undefined;
        const next = typeof body.new_password === "string" ? body.new_password : undefined;
        if (path !== "/users/@me") {
            const userId = (response as { user_id?: unknown } | null)?.user_id;
            return password && engine.rememberPassword(password, typeof userId === "string" ? userId : undefined);
        }
        if (!next) return;
        const token = (response as { token?: unknown } | null)?.token;
        engine.passwordChanged(password, next, typeof token === "string" ? tokenApi(token) : undefined).catch((error) => console.error("[e2ee] couldn't rewrap the backup", error));
    },
    onState: () => ui.refresh(),
    updateRecord: (message) => {
        try {
            loader.updateMessage?.(message.channel_id, message.id, {
                content: message.content ?? "",
                stickerItems: message.sticker_items ?? [],
                ...(message.soundboard_sounds?.length ? { soundboardSounds: message.soundboard_sounds } : {}),
            });
        } catch (error) {
            console.error("[e2ee] couldn't refresh a decrypted message", error);
        }
    },
    onError: (error, channelId) => ui.showError(error, channelId),
});

const selfTest = async () => {
    const agreement = await generateAgreementKey();
    const secret = randomBytes(32);
    const sealed = await hpkeSeal(await exportPublic(agreement.publicKey), secret, "self-test", "aad");
    const opened = await hpkeOpen(agreement, sealed.enc, sealed.wrapped, "self-test", "aad");
    if (toB64u(opened) !== toB64u(secret)) throw new Error("HPKE round trip failed");
    const iv = randomBytes(12);
    const ct = await aesEncrypt(secret, iv, secret, "aad");
    if (toB64u(await aesDecrypt(secret, iv, ct, "aad")) !== toB64u(secret)) throw new Error("AES-GCM round trip failed");
    const signing = await generateSigningKey();
    const signature = await sign(signing.privateKey, "self-test");
    if (!(await verify(await exportPublic(signing.publicKey), "self-test", signature))) throw new Error("Ed25519 round trip failed");
    if (await verify(await exportPublic(signing.publicKey), "self-tesT", signature)) throw new Error("Ed25519 accepted a bad signature");
    const prekey = engine.prekeys.reduce((a, b) => (b.id > a.id ? b : a));
    const probe = await hpkeSeal(prekey.publicKey, secret, "self-test", "aad");
    if (toB64u(await hpkeOpen(prekey.keyPair, probe.enc, probe.wrapped, "self-test", "aad")) !== toB64u(secret)) throw new Error("Stored prekey round trip failed");
};

let startAttempts = 0;
const start = async (userId: string) => {
    if (started || failure || signedOut) return;
    started = true;
    try {
        await engine.init(userId);
        ui.pause(null);
        await selfTest();
        void attachments.ready().then((controlled) => {
            if (!controlled) console.warn("[e2ee] the attachment service worker isn't controlling this page, so encrypted files won't load");
        });
        initialized = true;
        link.start(userId);
        engine.onUnlock(() => {
            hooks.retryAll();
            if (engine.linked) {
                link.cancel();
                link.unlocked();
            }
        });
        engine.onWipe(() => {
            link.reset();
            if (engine.locked && !ui.unlockSnoozed()) link.request().catch(() => {});
        });
        let wasLinked = engine.linked;
        engine.onChange(() => {
            if (wasLinked && engine.locked && !ui.unlockSnoozed()) link.request().catch(() => {});
            wasLinked = engine.linked;
            link.devicesChanged();
        });
        ui.refresh();
        if (engine.locked && engine.encryptedChannels.size && !ui.unlockSnoozed()) link.request().catch(() => {});
    } catch (error) {
        const response = error as { status?: unknown; body?: { retry_after?: unknown } } | null;
        if (typeof response?.status !== "number") return fail(`Self-test failed: ${describeError(error)}`);
        const retryAfter = Number(response.body?.retry_after);
        const limited = response.status === 429 && retryAfter > 0;
        const delay = limited ? Math.ceil(retryAfter) * 1000 + 1000 : Math.min(5000 * 2 ** startAttempts, 300000);
        startAttempts++;
        console.warn(`[e2ee] couldn't start (${describeError(error)}), retrying in ${Math.round(delay / 1000)}s`);
        ui.pause(
            limited
                ? t("Encryption is paused because this account set up too many browsers recently. It will try again at {time}.", {
                      time: new Date(Date.now() + delay).toLocaleTimeString(locale(), {
                          hour: "numeric",
                          minute: "2-digit",
                      }),
                  })
                : t("Encryption couldn't reach the server, so sending in encrypted conversations is paused. It will try again shortly."),
        );
        setTimeout(() => {
            started = false;
            start(userId);
        }, delay);
    }
};

const startWhenReady = () => {
    if (started || probing || failure || signedOut || loggedOut || !http || Date.now() - lastProbe < 10000) return;
    lastProbe = Date.now();
    probing = true;
    api.request<{ id?: unknown }>("get", "/users/@me")
        .then(
            (me) => {
                if (!loggedOut && !signedOut && typeof me?.id === "string" && /^[0-9]+$/.test(me.id)) return start(me.id);
            },
            () => {},
        )
        .finally(() => {
            probing = false;
        });
};

const received: Record<string, number> = {};
const count = (type: string) => (received[type] = (received[type] ?? 0) + 1);

let selfRefresh: ReturnType<typeof setTimeout> | null = null;
let loggedOut = false;
const refreshSelf = (userId: string) => {
    if (userId !== engine.userId || !initialized || selfRefresh || signedOut) return;
    selfRefresh = setTimeout(() => {
        selfRefresh = null;
        engine.refresh().catch((error) => console.error("[e2ee] refresh failed", error));
    }, 500);
};

const custom = {
    E2EE_DEVICES_UPDATE: (data: Record<string, unknown>) => {
        count("E2EE_DEVICES_UPDATE");
        engine.invalidateUser(String(data.user_id));
        refreshSelf(String(data.user_id));
        ui.refresh();
    },
    E2EE_IDENTITY_UPDATE: (data: Record<string, unknown>) => {
        count("E2EE_IDENTITY_UPDATE");
        const userId = String(data.user_id);
        engine.invalidateUser(userId);
        refreshSelf(userId);
        if (initialized && !signedOut && userId !== engine.userId) engine.keysFor([userId]).catch((error) => console.error("[e2ee] couldn't check the new safety number", error));
        ui.refresh();
    },
    E2EE_TRUST_UPDATE: () => {
        count("E2EE_TRUST_UPDATE");
        if (initialized && !signedOut) engine.syncTrust().catch((error) => console.error("[e2ee] couldn't sync verifications", error));
    },
    E2EE_LINK_REQUEST: (data: Record<string, unknown>) => {
        count("E2EE_LINK_REQUEST");
        if (initialized) link.onEvent("E2EE_LINK_REQUEST", data as unknown as LinkEvent);
    },
    E2EE_LINK_RESPONSE: (data: Record<string, unknown>) => {
        count("E2EE_LINK_RESPONSE");
        if (initialized) link.onEvent("E2EE_LINK_RESPONSE", data as unknown as LinkEvent);
    },
    CHANNEL_E2EE_UPDATE: (data: Record<string, unknown>) => {
        count("CHANNEL_E2EE_UPDATE");
        if (data.enabled) engine.setChannelEncrypted(String(data.channel_id));
    },
};

const installed = { dispatcher: false, http: false, gateway: false };
const startedAt = Date.now();

const tick = () => {
    if (failure) return;
    scan(loader.reqs, targets);
    if (targets.http && !installed.http) {
        installed.http = true;
        const originals = hooks.wrapHttp(targets.http);
        http = originals;
    }
    if (targets.dispatcher && !installed.dispatcher) {
        installed.dispatcher = true;
        hooks.watchDispatcher(targets.dispatcher);
        targets.dispatcher.subscribe("LOGOUT", () => {
            loggedOut = true;
            link.stop();
        });
        targets.dispatcher.subscribe("CONNECTION_OPEN", (action) => {
            if (loggedOut) return location.reload();
            const user = action.user as { id?: string } | undefined;
            if (user?.id) start(user.id);
            else startWhenReady();
        });
        targets.dispatcher.subscribe("CHANNEL_RECIPIENT_ADD", (action) => engine.invalidateChannel(String(action.channelId)));
        targets.dispatcher.subscribe("CHANNEL_RECIPIENT_REMOVE", (action) => engine.invalidateChannel(String(action.channelId)));
    }
    if (targets.gateway && !installed.gateway && targets.gateway.getSocket().dispatcher.getDispatchHandler) {
        installed.gateway = true;
        hooks.wrapGateway(targets.gateway, custom);
    }
    if (installed.http && installed.dispatcher && installed.gateway) {
        if (initialized) return settle(true);
        if (!started && Date.now() - startedAt > 8000) startWhenReady();
    } else if (Date.now() - startedAt > HOOK_TIMEOUT_MS) {
        const missing = Object.entries(installed)
            .filter(([, ok]) => !ok)
            .map(([name]) => name);
        return fail(`Couldn't find ${missing.join(", ")} in this client build`);
    }
    setTimeout(tick, installed.http && installed.dispatcher ? 100 : 20);
};

loader.status = () => ({
    ready: initialized && !failure && installed.http && installed.dispatcher && installed.gateway,
    trustsServer: engine.trustsServer,
    serverRecoveryReady: engine.serverRecoveryReady,
    failure,
    userId: engine.userId,
    deviceId: engine.device?.deviceId ?? null,
    deviceStatus: engine.deviceStatus,
    linked: engine.linked,
    locked: engine.locked,
    holdsIdentity: !!engine.identity,
    trustedKey: engine.trustedKey,
    hasSecret: engine.hasSecret,
    backup: engine.backup
        ? {
              mode: engine.backup.mode,
              version: engine.backup.version,
              hasSecret: !!engine.backup.wrapped_secret,
              identityKey: engine.backup.identity_key,
          }
        : null,
    link: link.outgoing(),
    hooks: { ...installed },
    encryptedChannels: [...engine.encryptedChannels],
    states: Object.fromEntries(states),
    received: { ...received },
});

loader.isEncrypted = (channelId) => engine.isEncrypted(channelId);
loader.beforeSend = (channelId) => ui.beforeSend(channelId);
loader.mountSettings = (container) => ui.mountSettings(container);
loader.openSettings = () => ui.showSettings();

tick();
