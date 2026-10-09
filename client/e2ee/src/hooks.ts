import { Attachments, UploadRef } from "./attachments";
import { E2eeError, Engine, errorText, FALLBACK_CONTENT, RawMessage } from "./engine";
import { Payload, StickerMeta } from "./files";
import { DispatchHandler, Dispatcher, FluxAction, GatewayStore, HttpCall, HttpClient, HttpMethod, HttpOptions, HttpResponse } from "./webpack";
import { t } from "./i18n";

export type MessageState = "decrypted" | "pending" | "locked" | "missing" | "reset" | "failed";

export const DECRYPTING_CONTENT = "Decrypting…";
export const MISSING_CONTENT = "Sent before this browser was set up";
export const LOCKED_CONTENT = "Unlock this browser to read this message";
export const RESET_CONTENT = "Sent before encryption was reset";
export const FAILED_CONTENT = "This message couldn't be decrypted";

const decryptingContent = () => t(DECRYPTING_CONTENT);

const contentFor = (state: MessageState | undefined, fallback?: string, trustsServer = false) =>
    state === "missing"
        ? t(MISSING_CONTENT)
        : state === "locked"
          ? t(trustsServer ? "Preparing private chat…" : LOCKED_CONTENT)
          : state === "reset"
            ? t(RESET_CONTENT)
            : state === "failed"
              ? t(FAILED_CONTENT)
              : fallback;

const SEARCH_URL = /^\/channels\/(\d+)\/messages\/search(\/tabs)?$/;
const SEARCH_PAGES = 10;

interface SearchQuery {
    content?: string;
    author_id?: string | string[];
    offset?: number | string;
    limit?: number | string;
    sort_order?: string;
}

export interface HookContext {
    engine: Engine;
    attachments: Attachments;
    sticker: (id: string) => StickerMeta | null;
    ready: Promise<boolean>;
    states: Map<string, { state: MessageState; reason?: string }>;
    failClosed: () => boolean;
    isReady: () => boolean;
    onState: () => void;
    updateRecord: (message: RawMessage) => void;
    onCredentials: (path: string, body: { password?: unknown; new_password?: unknown }, response: unknown) => void;
    onLogout: () => void;
    onError: (error: unknown, channelId: string) => void;
    fetchEmbeds: (urls: string[]) => Promise<Record<string, unknown[]>>;
    fetchSoundmoji: (refs: string[]) => Promise<unknown[]>;
}

const AUTH_URL = /^\/auth\/(login|register)$/;

const MESSAGE_URL = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/;

const CREATE_ATTACHMENTS_URL = /^\/channels\/(\d+)\/attachments$/;

const isEncryptedMessage = (value: unknown): value is RawMessage & { encrypted: NonNullable<RawMessage["encrypted"]> } => {
    const message = value as RawMessage | null;
    return !!message && typeof message === "object" && !!message.encrypted && typeof message.id === "string" && typeof message.channel_id === "string";
};

const collect = (value: unknown, out: RawMessage[], depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return out;
    if (Array.isArray(value)) {
        value.forEach((item) => collect(item, out, depth + 1));
        return out;
    }
    if (isEncryptedMessage(value)) out.push(value);
    for (const key of Object.keys(value)) {
        const child = (value as Record<string, unknown>)[key];
        if (child && typeof child === "object" && key !== "encrypted") collect(child, out, depth + 1);
    }
    return out;
};

export const createHooks = (ctx: HookContext) => {
    const { engine, states } = ctx;
    const inflight = new Map<string, Promise<void>>();

    const retry = new Map<string, RawMessage>();
    const readable = new Map<string, Map<string, RawMessage>>();
    const searched = new Map<string, number>();
    const payloads = new Map<string, Payload>();
    let dispatcher: Dispatcher | null = null;
    const clone = (message: RawMessage) => JSON.parse(JSON.stringify(message)) as RawMessage;

    const remember = (message: RawMessage) => {
        let channel = readable.get(message.channel_id);
        if (!channel) readable.set(message.channel_id, (channel = new Map()));
        channel.set(message.id, clone(message));
    };

    const show = (message: RawMessage, payload: Payload) => {
        ctx.attachments.apply(message, payload);
        // the official account's safety notices travel inside the encrypted payload; the native card draws from an embed
        // on the message, so it is rebuilt here. Anybody else's embeds are ignored, so a user can't fake a notice.
        if (payload.embeds?.length && message.author?.system === true) {
            message.embeds = payload.embeds;
            message.content = "";
        }
        payloads.set(message.id, payload);
    };

    // Encrypted messages carry no server-made previews. The links found after decrypting are looked up one by one
    // (the server learns the links, not the message) and the previews are attached on this device only
    const previewed = new Map<string, unknown[]>();
    const previews = (message: RawMessage) => {
        try {
            if (localStorage.getItem("fosscord-e2ee-previews") === "0") return;
        } catch {
            /* storage unavailable: previews stay on */
        }
        const text = typeof message.content === "string" ? message.content : "";
        const urls = [...new Set((text.match(/<?https?:\/\/[^\s<>]+>?/g) ?? []).filter((u) => !u.startsWith("<")))].slice(0, 5);
        if (!urls.length) return;
        const apply = (found: Record<string, unknown[]>) => {
            const embeds = urls.flatMap((u) => found[u] ?? previewed.get(u) ?? []);
            if (!embeds.length) return;
            const target = readable.get(message.channel_id)?.get(message.id) ?? clone(message);
            const copy = target as RawMessage & { embeds?: unknown[]; flags?: number };
            copy.embeds = embeds;
            copy.flags = Number(copy.flags ?? 0) & ~4;
            redispatch(copy);
        };
        const missing = urls.filter((u) => !previewed.has(u));
        if (!missing.length) return void setTimeout(() => apply({}), 300);
        ctx.fetchEmbeds(missing)
            .then((found) => {
                for (const u of missing) previewed.set(u, found[u] ?? []);
                apply(found);
            })
            .catch(() => {});
    };

    // Soundmojis (<sound:guild:id>) are attached by the server for ordinary messages. For encrypted ones the ids found
    // after decrypting are looked up and the sounds attached here, before the message reaches the client's store: the
    // store reads them when it builds the message and ignores them on a later update
    const soundCache = new Map<string, unknown>();
    const soundmoji = async (message: RawMessage) => {
        const text = typeof message.content === "string" ? message.content : "";
        const refs = [...new Set([...text.matchAll(/<sound:(\d+):(\d+)>/g)].map(([, guild, sound]) => `${guild}:${sound}`))].slice(0, 25);
        if (!refs.length) return;
        const soundId = (ref: string) => ref.split(":")[1];
        const missing = refs.filter((ref) => !soundCache.has(soundId(ref)));
        if (missing.length) {
            try {
                for (const sound of (await ctx.fetchSoundmoji(missing)) as { sound_id?: string }[]) if (sound?.sound_id) soundCache.set(String(sound.sound_id), sound);
                for (const ref of missing) if (!soundCache.has(soundId(ref))) soundCache.set(soundId(ref), null);
            } catch {
                /* offline or rate limited: the text stays as it is */
            }
        }
        const sounds = refs.map((ref) => soundCache.get(soundId(ref))).filter(Boolean);
        if (!sounds.length) return;
        message.soundboard_sounds = sounds;
        // the store builds its record without them for messages that arrive in a list, so they are put on the record itself
        setTimeout(() => ctx.updateRecord(message), 400);
    };

    const decryptOne = (message: RawMessage) => {
        const key = `${message.id}:${message.encrypted?.sig}`;
        const sync = engine.cached(message);
        if (sync !== undefined) {
            show(message, sync);
            states.set(message.id, { state: "decrypted" });
            retry.delete(message.id);
            return soundmoji(message).then(() => {
                remember(message);
                previews(message);
            });
        }
        if (!ctx.isReady()) {
            if (ctx.failClosed()) {
                states.set(message.id, {
                    state: "failed",
                    reason: t("Encryption is unavailable in this client build"),
                });
                message.content = t(FAILED_CONTENT);
            } else {
                retry.set(message.id, clone(message));
                states.set(message.id, { state: "pending" });
                message.content = decryptingContent();
            }
            return Promise.resolve();
        }
        let pending = inflight.get(key);
        if (!pending) {
            const original = clone(message);
            pending = (async () => {
                try {
                    const payload = await engine.decrypt(message);
                    states.set(message.id, { state: "decrypted" });
                    retry.delete(message.id);
                    show(message, payload);
                    await soundmoji(message);
                    remember(message);
                    previews(message);
                } catch (error) {
                    const code = error instanceof E2eeError ? error.code : null;
                    const state: MessageState = code === "LOCKED" ? "locked" : code === "NO_KEY" ? "missing" : code === "RESET" ? "reset" : "failed";
                    states.set(message.id, { state, reason: errorText(error) });
                    if (state === "locked" || state === "missing") retry.set(message.id, original);
                    message.content = contentFor(state, undefined, engine.trustsServer);
                }
            })().finally(() => inflight.delete(key));
            inflight.set(key, pending);
            return pending.then(() => ctx.onState());
        }
        return pending.then(() => {
            const again = engine.cached(message);
            const state = states.get(message.id)?.state;
            if (again) show(message, again);
            else message.content = contentFor(state, message.content, engine.trustsServer);
            ctx.onState();
        });
    };

    const redispatch = (copy: RawMessage) => {
        dispatcher?.dispatch({ type: "MESSAGE_UPDATE", message: copy, e2eeLocal: true });
        if (states.get(copy.id)?.state === "decrypted") ctx.updateRecord(copy);
    };

    const retryAll = () => {
        if (!ctx.isReady()) return;
        const queued = [...retry.values()];
        retry.clear();
        for (const copy of queued) {
            const before = states.get(copy.id)?.state;
            decryptOne(copy).then(() => {
                const after = states.get(copy.id)?.state;
                if (after === before && after !== "pending") return;
                redispatch(copy);
                ctx.onState();
            });
        }
    };

    const decryptAll = async (value: unknown) => {
        const messages = collect(value, []);
        if (messages.length) await Promise.all(messages.map(decryptOne));
    };

    const encryptBody = async (method: HttpMethod, opts: HttpOptions) => {
        const match = MESSAGE_URL.exec(opts.url.split("?")[0]);
        if (!match || (method !== "post" && method !== "patch")) return opts;
        const [, channelId, messageId] = match;
        if (method === "post" && messageId) return opts;
        if (!engine.isEncrypted(channelId)) return opts;
        if (ctx.failClosed()) throw new E2eeError("NOT_READY", t("Encryption is unavailable in this client build"));
        if (!(await ctx.ready)) throw new E2eeError("NOT_READY", t("Encryption is unavailable in this client build"));
        const body = { ...((opts.body ?? {}) as Record<string, unknown>) };
        if (method === "patch" && body.content === undefined && body.attachments === undefined) return opts;
        if (body.poll) throw new E2eeError("UNSUPPORTED", t("Polls can't be sent in encrypted conversations yet"));
        if (opts.attachments?.length) throw new E2eeError("UNSUPPORTED", t("This file couldn't be encrypted"));
        const nonce = method === "post" ? String(body.nonce ?? `${Date.now()}${Math.floor(Math.random() * 1000)}`) : undefined;
        if (nonce) body.nonce = nonce;
        const payload: Payload = { content: String(body.content ?? "") };
        const refs = Array.isArray(body.attachments) ? (body.attachments as UploadRef[]) : [];
        if (method === "post") {
            const metas = refs.map((ref) => ctx.attachments.metaFor(ref));
            if (metas.some((meta) => !meta)) throw new E2eeError("UNSUPPORTED", t("A file wasn't encrypted before it was uploaded"));
            if (metas.length) {
                payload.attachments = metas.map((meta) => meta!);
                body.attachments = refs.map((ref, i) => ({
                    id: ref.id,
                    filename: metas[i]!.name,
                    uploaded_filename: ref.uploaded_filename,
                }));
            }
            const stickers = Array.isArray(body.sticker_ids) ? body.sticker_ids.map(String) : [];
            if (stickers.length) payload.stickers = stickers.map((id) => ctx.sticker(id) ?? { id, name: "", format_type: 1 });
            delete body.sticker_ids;
        } else {
            const previous = payloads.get(messageId);
            if (!previous) throw new E2eeError("NOT_READY", t("This message isn't decrypted in this browser yet"));
            if (body.content === undefined) payload.content = previous.content;
            let kept = previous.attachments;
            if (Array.isArray(body.attachments)) {
                const names = refs.map((ref) => ctx.attachments.nameOf(String(ref.id)));
                kept = kept?.filter((meta) => names.includes(meta.name));
                body.attachments = refs.map((ref, i) => ({ id: ref.id, filename: names[i] ?? "file.bin" }));
            }
            if (kept?.length) payload.attachments = kept;
            if (previous.stickers?.length) payload.stickers = previous.stickers;
        }
        body.encrypted = await engine.encrypt(channelId, payload, {
            nonce,
            mid: method === "patch" ? messageId : undefined,
        });
        body.content = FALLBACK_CONTENT;
        return { ...opts, body };
    };

    const searchLocally = async (originals: HttpClient, channelId: string, queries: SearchQuery[]) => {
        if (Date.now() - (searched.get(channelId) ?? 0) > 60000) {
            let before = "";
            for (let page = 0; page < SEARCH_PAGES; page++) {
                const res = await originals
                    .get({
                        url: `/channels/${channelId}/messages`,
                        query: { limit: 100, ...(before && { before }) },
                        rejectWithError: false,
                    })
                    .catch(() => null);
                const batch = (res?.ok ? res.body : []) as RawMessage[];
                await decryptAll(batch);
                if (batch.length < 100) break;
                before = batch[batch.length - 1].id;
            }
            searched.set(channelId, Date.now());
        }
        const all = [...(readable.get(channelId)?.values() ?? [])].filter((m) => states.get(m.id)?.state === "decrypted").sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
        return queries.map((query) => {
            const words = String(query.content ?? "")
                .toLowerCase()
                .split(/\s+/)
                .filter(Boolean);
            const authors = [query.author_id ?? []].flat().map(String);
            const hits = all.filter((m) => {
                const text = String(m.content ?? "").toLowerCase();
                return words.every((w) => text.includes(w)) && (!authors.length || authors.includes(String(m.author?.id)));
            });
            if (query.sort_order === "asc") hits.reverse();
            const offset = Number(query.offset ?? 0) || 0;
            const limit = Number(query.limit ?? 25) || 25;
            return {
                analytics_id: null,
                doing_deep_historical_index: false,
                total_results: hits.length,
                messages: hits.slice(offset, offset + limit).map((m) => [{ ...m, hit: true }]),
                threads: [],
                members: [],
            };
        });
    };

    const wrapHttp = (http: HttpClient) => {
        const originals = { ...http };
        for (const method of ["get", "post", "put", "patch", "del"] as HttpMethod[]) {
            const original = originals[method];
            const wrapped: HttpCall = (input, callback) => {
                const opts: HttpOptions = typeof input === "string" ? { url: input, rejectWithError: false } : input;
                const url = typeof opts?.url === "string" ? opts.url : "";
                const path = url.split("?")[0];
                if (method === "post" && path === "/auth/logout") ctx.onLogout();
                if ((method === "post" && AUTH_URL.test(path)) || (method === "patch" && path === "/users/@me")) {
                    const body = (opts.body ?? {}) as { password?: unknown; new_password?: unknown };
                    const result = original(input, callback);
                    result.then(
                        (res) => res?.ok && ctx.onCredentials(path, body, res.body),
                        () => {},
                    );
                    return result;
                }
                if (method === "put" && ctx.attachments.isUpload(url)) {
                    const upload = (async () => {
                        const prepared = await ctx.attachments.prepareUpload(opts as HttpOptions & { headers?: Record<string, string> });
                        const result = await original(prepared, callback);
                        if (result?.ok) ctx.attachments.uploaded(url);
                        return result;
                    })();
                    upload.catch(() => {});
                    return upload;
                }
                const create = method === "post" ? CREATE_ATTACHMENTS_URL.exec(path) : null;
                if (create && engine.isEncrypted(create[1])) {
                    const created = (async () => {
                        if (ctx.failClosed() || !(await ctx.ready)) {
                            const error = new E2eeError("NOT_READY", t("Encryption is unavailable in this client build"));
                            ctx.onError(error, create[1]);
                            throw error;
                        }
                        const { body, track } = ctx.attachments.prepareCreate((opts.body ?? {}) as { files?: Record<string, unknown>[] });
                        const headers = Object.fromEntries(Object.entries((opts.headers ?? {}) as Record<string, string>).filter(([name]) => !/md5/i.test(name)));
                        const result = await original({ ...opts, body, headers }, callback);
                        if (result?.ok) track(result.body);
                        return result;
                    })();
                    created.catch(() => {});
                    return created;
                }
                const relevant = url.startsWith("/channels/") || url.startsWith("/users/@me/mentions") || url.includes("/messages");
                if (!relevant) return original(input, callback);
                const search = SEARCH_URL.exec(path);
                if (search && engine.isEncrypted(search[1]) && (method === "get" || (method === "post" && search[2]))) {
                    const [, channelId, tabs] = search;
                    return (async () => {
                        const params = new URLSearchParams(url.split("?")[1] ?? "");
                        const extra = opts.query;
                        if (typeof extra === "string") new URLSearchParams(extra).forEach((value, name) => params.append(name, value));
                        else if (extra && typeof extra === "object")
                            Object.entries(extra).forEach(([name, value]) => [value].flat().forEach((v) => v != null && params.append(name, String(v))));
                        const query: SearchQuery = {
                            content: params.get("content") ?? undefined,
                            author_id: params.getAll("author_id"),
                            offset: params.get("offset") ?? undefined,
                            limit: params.get("limit") ?? undefined,
                            sort_order: params.get("sort_order") ?? undefined,
                        };
                        const named = tabs ? Object.entries(((opts.body ?? {}) as { tabs?: Record<string, SearchQuery> }).tabs ?? {}) : [];
                        const results = await searchLocally(originals, channelId, tabs ? named.map(([, q]) => q) : [query]);
                        const body = tabs
                            ? {
                                  tabs: Object.fromEntries(named.map(([name], i) => [name, { ...results[i], cursor: null }])),
                                  analytics_id: null,
                                  doing_deep_historical_index: false,
                              }
                            : results[0];
                        const response = { ok: true, status: 200, body, headers: {} };
                        callback?.({ ...response, hasErr: false });
                        return response;
                    })();
                }
                const pending = (async () => {
                    let prepared: HttpOptions;
                    try {
                        prepared = await encryptBody(method, opts);
                    } catch (error) {
                        const match = MESSAGE_URL.exec(url.split("?")[0]);
                        ctx.onError(error, match?.[1] ?? "");
                        callback?.({ ok: false, hasErr: true, err: error, status: 0, body: null });
                        throw error;
                    }
                    for (let attempt = 0; ; attempt++) {
                        let response: (HttpResponse & { hasErr?: boolean }) | undefined;
                        try {
                            const result = await original(prepared, (res) => (response = res));
                            if (prepared !== opts && result?.ok)
                                ctx.attachments.sent(((opts.body as { attachments?: UploadRef[] } | undefined)?.attachments ?? []).filter(Boolean));
                            await decryptAll(result?.body);
                            callback?.(response ?? { ...result, hasErr: false });
                            return result;
                        } catch (error) {
                            const failure = error as { status?: number; body?: { message?: string } };
                            if (attempt === 0 && failure?.status === 409 && failure.body?.message === "E2EE_DEVICE_MISMATCH" && prepared !== opts) {
                                const match = MESSAGE_URL.exec(url.split("?")[0])!;
                                engine.invalidateChannel(match[1]);
                                engine.invalidateAll();
                                prepared = await encryptBody(method, opts);
                                continue;
                            }
                            if (response) callback?.(response);
                            throw error;
                        }
                    }
                })();
                pending.catch(() => {});
                return pending;
            };
            http[method] = wrapped;
        }
        return originals;
    };

    const wrapGateway = (store: GatewayStore, custom: Record<string, (data: Record<string, unknown>) => void>) => {
        const socketDispatcher = store.getSocket().dispatcher;
        let current = socketDispatcher.getDispatchHandler;
        const cache = new Map<string, { base: DispatchHandler | undefined; wrapped: DispatchHandler | undefined }>();
        const wrap = (type: string) => {
            const base = current?.(type);
            const hit = cache.get(type);
            if (hit && hit.base === base) return hit.wrapped;
            let wrapped = base;
            if (custom[type])
                wrapped = {
                    preload: () => null,
                    dispatch: (data) => custom[type](data as Record<string, unknown>),
                };
            else if (base && (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE")) {
                wrapped = {
                    ...base,
                    preload: (data) => {
                        const own = base.preload(data);
                        if (!collect(data, []).length) return own;
                        return Promise.all([own, decryptAll(data)]).then(([result]) => result);
                    },
                    dispatch: (...args) => base.dispatch(...args),
                };
            }
            cache.set(type, { base, wrapped });
            return wrapped;
        };
        Object.defineProperty(socketDispatcher, "getDispatchHandler", {
            configurable: true,
            get: () => (current ? wrap : null),
            set: (value) => {
                current = value;
                cache.clear();
            },
        });
    };

    const watchDispatcher = (target: Dispatcher) => {
        dispatcher = target;
        target.addInterceptor((action: FluxAction) => {
            if ((action as { e2eeLocal?: boolean }).e2eeLocal || !/MESSAGE|SEARCH|PIN|MENTION|THREAD/.test(action.type)) return false;
            const messages = collect(action, []).filter((m) => m.content === FALLBACK_CONTENT && !states.has(m.id));
            for (const message of messages) {
                const hit = engine.cached(message);
                if (hit !== undefined) {
                    show(message, hit);
                    states.set(message.id, { state: "decrypted" });
                    remember(message);
                    previews(message);
                    continue;
                }
                const copy = clone(message);
                message.content = decryptingContent();
                decryptOne(copy).then(() => {
                    if (states.get(copy.id)?.state !== "pending") redispatch(copy);
                });
            }
            return false;
        });
    };

    return { wrapHttp, wrapGateway, watchDispatcher, decryptAll, retryAll };
};
