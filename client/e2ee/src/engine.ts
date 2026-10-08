import { BackupMode, BackupRecord, generateRecoveryCode, openJwk, openTrust, sealJwk, sealTrust, TrustMap, unwrapSecret, wrapSecret } from "./backup";
import { Bytes, fromB64u, fromUtf8, randomBytes, sha256, toB64u, utf8 } from "./bytes";
import {
    aesDecrypt,
    aesEncrypt,
    ALGORITHM,
    backupKeyMessage,
    deviceIdFor,
    deviceMessage,
    exportPublic,
    generateAgreementKey,
    generateExportable,
    generateSigningKey,
    hpkeOpen,
    hpkeSeal,
    importAgreementJwk,
    importSigningJwk,
    OkpJwk,
    prekeyMessage,
    rotationMessage,
    sign,
    verify,
    x25519,
} from "./crypto";
import { parsePayload, Payload } from "./files";
import { Contact, dropPendingPassword, holdPendingPassword, scoped, Store, StoredDevice, StoredIdentity, StoredPrekey, takePendingPassword } from "./store";
import { t } from "./i18n";

export const FALLBACK_CONTENT = "🔒 Encrypted message";
const WRAP_INFO = "fosscord-e2ee/v1/wrap";
const BACKUP_INFO = "fosscord-e2ee/v1/backup-wrap";
const PREKEY_ROTATE_MS = 7 * 24 * 3600 * 1000;
const PREKEY_KEEP_MS = 30 * 24 * 3600 * 1000;
const DIRECTORY_TTL_MS = 5 * 60 * 1000;
const PASSWORD_TTL_MS = 10 * 60 * 1000;

export interface EnvelopeKey {
    user_id: string;
    device_id: string;
    prekey_id: number;
    enc: string;
    wrapped: string;
}

export interface EnvelopeBackupKey {
    user_id: string;
    enc: string;
    wrapped: string;
}

export interface Envelope {
    v: number;
    alg: string;
    sender_device: string;
    mid?: string;
    iv: string;
    ct: string;
    keys: EnvelopeKey[];
    backup?: EnvelopeBackupKey[];
    sig: string;
}

export interface RawAttachment {
    id: string;
    filename: string;
    url?: string;
    proxy_url?: string;
    flags?: number;
    [key: string]: unknown;
}

export interface RawMessage {
    id: string;
    channel_id: string;
    content?: string;
    nonce?: string | number | null;
    author?: { id: string };
    flags?: number;
    embeds?: unknown[];
    soundboard_sounds?: unknown[];
    attachments?: RawAttachment[];
    sticker_items?: unknown[];
    encrypted?: Envelope | null;
}

export interface ServerDevice {
    device_id: string;
    signing_key: string;
    identity_signature: string | null;
    status: "active" | "pending" | "revoked";
    name: string | null;
    prekey: { id: number; public_key: string; signature: string };
    created_at?: string;
    revoked_at?: string | null;
    session?: {
        signed_in: boolean;
        last_seen: string | null;
        os: string | null;
        browser: string | null;
        location: string | null;
    } | null;
}

interface SignedKey {
    public_key: string;
    signature: string;
}

interface ServerUserKeys {
    identity_key: string | null;
    identity_created_at?: string | null;
    previous_identity?: SignedKey | null;
    backup_key?: SignedKey | null;
    devices: ServerDevice[];
}

interface ServerState extends ServerUserKeys {
    channels: string[];
    private_by_default?: boolean;
}

export interface DirectoryDevice {
    deviceId: string;
    signingKey: string;
    status: ServerDevice["status"];
    name: string | null;
    prekeyId: number;
    prekeyPublic: string;
    revokedAt: number | null;
}

export interface DirectoryEntry {
    userId: string;
    identityKey: string | null;
    identityCreatedAt: number | null;
    identityChanged: boolean;
    backupKey: string | null;
    devices: DirectoryDevice[];
    fetchedAt: number;
}

export interface ChannelMember {
    id: string;
    username: string;
    global_name?: string | null;
}

export interface Api {
    request<T>(method: "get" | "post" | "put" | "patch" | "del", url: string, body?: unknown): Promise<T>;
}

export class E2eeError extends Error {
    constructor(
        readonly code:
            | "NOT_READY"
            | "NOT_LINKED"
            | "LOCKED"
            | "BAD_SECRET"
            | "IDENTITY_CHANGED"
            | "NO_DEVICES"
            | "UNSUPPORTED"
            | "BAD_ENVELOPE"
            | "NO_KEY"
            | "BAD_SIGNATURE"
            | "RESET",
        message: string,
        readonly userId?: string,
    ) {
        super(message);
    }
}

export const errorText = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    const failure = error as {
        status?: number;
        body?: { message?: unknown; retry_after?: unknown };
    } | null;
    if (failure && typeof failure === "object") {
        if (failure.status === 429) {
            const minutes = Math.max(1, Math.ceil(Number(failure.body?.retry_after ?? 60) / 60));
            return `Too many attempts. Try again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
        }
        if (typeof failure.body?.message === "string") return failure.body.message;
        if (failure.status) return `The server answered with an error (${failure.status}).`;
    }
    return String(error);
};

export const snowflakeTime = (id: string) => {
    try {
        return Number((BigInt(id) >> 22n) + 1420070400000n);
    } catch {
        return 0;
    }
};

const binding = (mid: string | undefined, nonce: string | undefined) => (mid ? `m:${mid}` : `n:${nonce ?? ""}`);

const messageAad = (channelId: string, senderId: string, senderDevice: string, bind: string) => `fosscord-e2ee/v1/msg\n${channelId}\n${senderId}\n${senderDevice}\n${bind}`;

const storedKeyAad = (userId: string, messageId: string, sig: string) => `fosscord-e2ee/v1/backup-key\n${userId}\n${messageId}\n${sig}`;

const sameBytes = (a: Bytes, b: Bytes) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const sleep = (ms: number) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

const signedPayload = (channelId: string, senderId: string, bind: string, env: Omit<Envelope, "sig">) => {
    const base = [
        "fosscord-e2ee/v1/sig",
        channelId,
        senderId,
        bind,
        env.v,
        env.alg,
        env.sender_device,
        env.mid ?? null,
        env.iv,
        env.ct,
        [...env.keys].sort((a, b) => (a.device_id < b.device_id ? -1 : 1)).map((k) => [k.user_id, k.device_id, k.prekey_id, k.enc, k.wrapped]),
    ];
    if (env.backup) base.push([...env.backup].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)).map((b) => [b.user_id, b.enc, b.wrapped]));
    return JSON.stringify(base);
};

export const deviceName = () => {
    const ua = navigator.userAgent;
    const brave = !!(navigator as Navigator & { brave?: unknown }).brave;
    const browser = brave
        ? "Brave"
        : /Edg\//.test(ua)
          ? "Edge"
          : /OPR\//.test(ua)
            ? "Opera"
            : /Vivaldi\//.test(ua)
              ? "Vivaldi"
              : /Firefox\//.test(ua)
                ? "Firefox"
                : /Chrome\//.test(ua)
                  ? "Chrome"
                  : /Safari\//.test(ua)
                    ? "Safari"
                    : "a browser";
    const os = /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Android/.test(ua)
            ? "Android"
            : /iPhone|iPad/.test(ua)
              ? "iOS"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
    return os ? `${browser} on ${os}` : browser;
};

const addedAt = (iso: string, seconds: boolean) =>
    new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(seconds && { second: "2-digit" }),
    });

export const deviceTitle = (device: ServerDevice) => {
    const os = device.session?.os;
    const browser = device.session?.browser;
    if (os) return browser ? `${os} • ${browser}` : os;
    return device.name;
};

export const deviceAdded = (devices: ServerDevice[], device: ServerDevice) => {
    if (!device.created_at) return null;
    const minutes = devices.filter((d) => d.status !== "revoked" && d.created_at).map((d) => addedAt(d.created_at!, false));
    return addedAt(device.created_at, new Set(minutes).size < minutes.length);
};

export const deviceTwins = (devices: ServerDevice[], device: ServerDevice) => devices.filter((d) => d.status !== "revoked" && deviceTitle(d) === deviceTitle(device));

export const deviceLabel = (devices: ServerDevice[], deviceId: string, fallback: string) => {
    const device = devices.find((d) => d.device_id === deviceId);
    const title = device && deviceTitle(device);
    if (!device || !title) return fallback;
    const twins = deviceTwins(devices, device);
    const added = twins.length > 1 ? deviceAdded(twins, device) : null;
    return added ? `${title}, added ${added}` : title;
};

export class Engine {
    userId = "";
    linked = false;
    deviceStatus: ServerDevice["status"] | "unregistered" = "unregistered";
    identity: StoredIdentity | null = null;
    trustedKey: string | null = null;
    serverKey: string | null = null;
    identityCreatedAt: number | null = null;
    previousIdentities: string[] = [];
    device: StoredDevice | null = null;
    devices: ServerDevice[] = [];
    prekeys: StoredPrekey[] = [];
    contacts: Record<string, Contact> = {};
    encryptedChannels = new Set<string>();
    backup: BackupRecord | null = null;
    backupKeyPair: { publicKey: string; keyPair: CryptoKeyPair } | null = null;
    private secret: Bytes | null = null;
    private password: { value: string; at: number } | null = null;
    private store: Store | null = null;
    private queue: Promise<void> = Promise.resolve();
    private directory = new Map<string, Promise<DirectoryEntry>>();
    private members = new Map<string, Promise<string[]>>();
    private profiles = new Map<string, Promise<ChannelMember>>();
    private plaintext = new Map<string, Payload>();
    private listeners = new Set<() => void>();
    private unlockListeners = new Set<() => void>();
    private wipeListeners = new Set<() => void>();
    private uploads = new Map<string, { message_id: string; enc: string; wrapped: string; sig: string }>();
    private uploadTimer: ReturnType<typeof setTimeout> | null = null;
    private lookups = new Map<
        string,
        {
            promise: Promise<EnvelopeBackupKey | null>;
            resolve: (value: EnvelopeBackupKey | null) => void;
        }
    >();
    private lookupTimer: ReturnType<typeof setTimeout> | null = null;
    private storedKeys = new Map<string, EnvelopeBackupKey>();
    private backfilling = false;
    private wiped = false;
    private freshIdentity: OkpJwk | null = null;
    private trustVersion = -1;

    private privateByDefault = true;
    private recoveryPublished = "";
    private recoveryPublishing = new Map<string, Promise<void>>();

    constructor(
        private api: Api,
        private classifyChannel: (channelId: string, privateByDefault: boolean) => boolean = () => false,
        private trustDirectory: () => boolean = () => false,
    ) {}

    get trustsServer() {
        return this.trustDirectory();
    }

    get serverRecoveryReady() {
        return (
            !!this.backup &&
            !!this.device &&
            this.recoveryPublished === `${this.backup.identity_key}:${this.backup.backup_public_key}:${this.backup.version}:${this.device.deviceId}`
        );
    }

    onChange(listener: () => void) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onUnlock(listener: () => void) {
        this.unlockListeners.add(listener);
        return () => this.unlockListeners.delete(listener);
    }

    onWipe(listener: () => void) {
        this.wipeListeners.add(listener);
        return () => this.wipeListeners.delete(listener);
    }

    private holdPassword(value: string, persist = false) {
        this.password = { value, at: Date.now() };
        if (persist) holdPendingPassword(this.userId, value).catch((error) => console.error("[e2ee] couldn't keep the password for a reload", error));
    }

    private dropPassword() {
        this.password = null;
        dropPendingPassword();
    }

    emit() {
        this.listeners.forEach((listener) => listener());
    }

    get hasSecret() {
        return !!this.secret;
    }

    get locked() {
        return !!this.userId && !this.linked;
    }

    get backupNeedsPassword() {
        if (!this.linked || !this.identity || this.identity.publicKey !== this.serverKey) return false;
        const backup = this.backup?.identity_key === this.serverKey ? this.backup : null;
        if (!backup) return true;
        return backup.mode === "password" && !backup.wrapped_secret && !!this.secret;
    }

    async backUpWithPassword(password: string) {
        this.holdPassword(password);
        await this.refresh();
        if (this.backupNeedsPassword) throw new E2eeError("BAD_SECRET", t("Your keys couldn't be backed up. Try again in a moment."));
    }

    rememberPassword(value: string, userId?: string) {
        this.password = { value, at: Date.now() };
        holdPendingPassword(userId ?? this.userId, value).catch((error) => console.error("[e2ee] couldn't keep the password for a reload", error));
        if (this.userId) this.refresh().catch((error) => console.error("[e2ee] password refresh failed", error));
    }

    async passwordChanged(previous: string | undefined, next: string, api: Api = this.api) {
        if (!this.userId) return this.rememberPassword(next);
        await this.serialized(async () => {
            const backup = (this.backup = await this.fetchBackup(api));
            if (!backup || backup.mode !== "password") return;
            let secret = this.secret;
            if (!secret && previous && backup.wrapped_secret) secret = await unwrapSecret(this.userId, backup, previous).catch(() => null);
            if (!secret) {
                this.holdPassword(next, true);
                return;
            }
            this.backup = await api.request<BackupRecord>("patch", "/users/@me/e2ee/backup", {
                version: backup.version,
                ...(await wrapSecret(this.userId, "password", next, secret)),
            });
            this.dropPassword();
        });
        this.emit();
    }

    async init(userId: string) {
        this.userId = userId;
        this.store = scoped(userId);
        this.contacts = (await this.store.get<Record<string, Contact>>("contacts")) ?? {};
        this.previousIdentities = (await this.store.get<string[]>("previous-identities")) ?? [];
        const pending = await takePendingPassword(userId, PASSWORD_TTL_MS);
        if (pending && !this.password) this.password = pending;
        await this.refresh();
    }

    private serialized<T>(task: () => Promise<T>) {
        const run = this.queue.then(task);
        this.queue = run.then(
            () => {},
            () => {},
        );
        return run;
    }

    private exclusive<T>(task: () => Promise<T>): Promise<T> {
        return navigator.locks ? navigator.locks.request(`fosscord-e2ee-keys:${this.userId}`, task) : task();
    }

    async refresh() {
        const wasLinked = this.linked;
        const hadBackupKey = !!this.backupKeyPair;
        await this.serialized(() => this.exclusive(() => this.ensureKeys()));
        if (this.wiped) {
            this.wiped = false;
            this.wipeListeners.forEach((listener) => listener());
        }
        this.emit();
        if ((!wasLinked && this.linked) || (!hadBackupKey && this.backupKeyPair)) this.unlockListeners.forEach((listener) => listener());
        if (this.linked && this.backupKeyPair) this.backfill().catch((error) => console.error("[e2ee] backfill failed", error));
    }

    private async saveContacts() {
        await this.store!.set("contacts", this.contacts);
    }

    private async newPrekey(id: number) {
        const keyPair = await generateAgreementKey();
        const publicKey = await exportPublic(keyPair.publicKey);
        const signature = await sign(this.device!.privateKey, prekeyMessage(this.device!.deviceId, id, publicKey));
        return {
            id,
            publicKey,
            signature,
            keyPair,
            createdAt: Date.now(),
            retiredAt: null,
        } satisfies StoredPrekey;
    }

    private currentPrekey() {
        return this.prekeys.reduce((a, b) => (b.id > a.id ? b : a));
    }

    private async fetchBackup(api: Api = this.api) {
        try {
            return await api.request<BackupRecord>("get", "/users/@me/e2ee/backup");
        } catch (error) {
            if ((error as { status?: number })?.status === 404) return null;
            throw error;
        }
    }

    private async adoptIdentity(jwk: OkpJwk) {
        const identity = { publicKey: jwk.x, privateKey: await importSigningJwk(jwk) };
        await this.store!.set("identity", identity);
        await this.trust(jwk.x);
        this.identity = identity;
        return identity;
    }

    private async rememberIdentity(key: string | null) {
        if (!key || this.previousIdentities.includes(key)) return;
        this.previousIdentities = [...this.previousIdentities, key].slice(-16);
        await this.store!.set("previous-identities", this.previousIdentities);
    }

    private async trust(key: string) {
        if (this.trustedKey === key) return;
        await this.rememberIdentity(this.trustedKey);
        this.trustedKey = key;
        await this.store!.set("trusted-identity", key);
    }

    private async restoreFromSecret(secret: Bytes, backup: BackupRecord) {
        if (secret.byteLength !== 32) throw new Error("invalid backup secret");
        const identityJwk = await openJwk(secret, "identity", this.userId, backup.wrapped_identity);
        const backupJwk = await openJwk(secret, "backup-key", this.userId, backup.wrapped_backup_key);
        const valid = (jwk: OkpJwk, curve: string, publicKey: string) =>
            jwk.kty === "OKP" && jwk.crv === curve && jwk.x === publicKey && typeof jwk.d === "string" && fromB64u(jwk.d).byteLength === 32 && fromB64u(jwk.x).byteLength === 32;
        if (!valid(identityJwk, "Ed25519", backup.identity_key) || !valid(backupJwk, "X25519", backup.backup_public_key)) throw new Error("backup keys don't match");
        if (!(await verify(backup.identity_key, backupKeyMessage(this.userId, backup.backup_public_key), backup.backup_key_signature)))
            throw new Error("invalid backup key signature");
        const identityPrivate = await importSigningJwk(identityJwk);
        const challenge = toB64u(randomBytes(32));
        if (!(await verify(backup.identity_key, challenge, await sign(identityPrivate, challenge)))) throw new Error("backup identity private key doesn't match");
        const pair = await importAgreementJwk(backupJwk);
        const probe = await generateAgreementKey();
        if (!sameBytes(await x25519(pair.privateKey, await exportPublic(probe.publicKey)), await x25519(probe.privateKey, backup.backup_public_key)))
            throw new Error("backup private key doesn't match");
        await this.adoptIdentity(identityJwk);
        this.backupKeyPair = { publicKey: backupJwk.x, keyPair: pair };
        this.secret = secret;
        await this.store!.set("backup-secret", secret);
        return identityJwk;
    }

    private async serverSecret(password: string) {
        if (!this.trustsServer) return null;
        const response = await this.api.request<{ backup_secret: string }>("post", "/users/@me/e2ee/backup/escrow/recover", { password });
        const secret = fromB64u(response.backup_secret);
        if (secret.byteLength !== 32 || toB64u(secret) !== response.backup_secret) throw new Error("invalid server recovery secret");
        return secret;
    }

    async recoverWithPassword(password: string) {
        const secret = await this.serverSecret(password);
        if (!secret) return false;
        await this.unlockWithSecret(secret);
        return this.linked;
    }

    private async publishServerRecovery(api: Api = this.api) {
        const backup = this.backup;
        const identity = this.identity;
        const device = this.device;
        if (!this.trustsServer || !this.linked || !this.secret || !identity || !device || !backup || backup.identity_key !== identity.publicKey) return;
        const key = `${backup.identity_key}:${backup.backup_public_key}:${backup.version}:${device.deviceId}`;
        if (this.recoveryPublished === key) return;
        const pending = this.recoveryPublishing.get(key);
        if (pending) return pending;
        const originalSecret = this.secret;
        const secret = originalSecret.slice();
        const userId = this.userId;
        const current = () =>
            this.trustsServer &&
            this.linked &&
            this.userId === userId &&
            this.identity === identity &&
            this.device === device &&
            this.backup === backup &&
            this.secret === originalSecret &&
            `${backup.identity_key}:${backup.backup_public_key}:${backup.version}:${device.deviceId}` === key;
        const publish = async () => {
            try {
                const status = await api.request<{
                    ready: boolean;
                    identity_key?: string;
                    backup_public_key?: string;
                    backup_version?: number;
                }>("get", "/users/@me/e2ee/backup/escrow");
                if (!current()) return;
                if (
                    !status.ready ||
                    status.identity_key !== backup.identity_key ||
                    status.backup_public_key !== backup.backup_public_key ||
                    status.backup_version !== backup.version
                ) {
                    const digest = toB64u(await sha256(secret));
                    if (!current()) return;
                    const message = `fosscord-e2ee/v1/server-recovery\n${userId}\n${backup.identity_key}\n${backup.version}\n${device.deviceId}\n${digest}`;
                    const signature = await sign(identity.privateKey, message);
                    if (!current()) return;
                    await api.request("put", "/users/@me/e2ee/backup/escrow", {
                        identity_key: backup.identity_key,
                        backup_version: backup.version,
                        device_id: device.deviceId,
                        backup_secret: toB64u(secret),
                        signature,
                    });
                }
                if (current()) this.recoveryPublished = key;
            } finally {
                secret.fill(0);
                this.recoveryPublishing.delete(key);
            }
        };
        const promise = Promise.resolve().then(publish);
        this.recoveryPublishing.set(key, promise);
        return promise;
    }

    private passwordValue() {
        if (this.password && Date.now() - this.password.at > PASSWORD_TTL_MS) this.password = null;
        return this.password?.value ?? null;
    }

    private async createBackup(state: ServerState, identityJwk: OkpJwk | null) {
        if (!this.passwordValue()) return;
        const userId = this.userId;
        let identity = this.identity!;
        if (!identityJwk) {
            identityJwk = await generateExportable("Ed25519");
            const next = { publicKey: identityJwk.x, privateKey: await importSigningJwk(identityJwk) };
            const devices: { device_id: string; identity_signature: string }[] = [];
            for (const d of state.devices) {
                if (d.status === "revoked" || !d.identity_signature) continue;
                if (!(await verify(identity.publicKey, deviceMessage(userId, d.device_id, d.signing_key), d.identity_signature))) continue;
                devices.push({
                    device_id: d.device_id,
                    identity_signature: await sign(next.privateKey, deviceMessage(userId, d.device_id, d.signing_key)),
                });
            }
            const previous_signature = await sign(identity.privateKey, rotationMessage(userId, identity.publicKey, next.publicKey));
            Object.assign(
                state,
                await this.api.request<ServerState>("put", "/users/@me/e2ee/identity", {
                    public_key: next.publicKey,
                    previous_signature,
                    devices,
                }),
            );
            identity = await this.adoptIdentity(identityJwk);
            this.directory.delete(userId);
        }
        const password = this.passwordValue();
        if (!password) return;
        const secret = randomBytes(32);
        const backupJwk = await generateExportable("X25519");
        const secretFields = await wrapSecret(userId, "password", password, secret);
        this.backup = await this.api.request<BackupRecord>("put", "/users/@me/e2ee/backup", {
            version: this.backup?.version ?? 0,
            ...secretFields,
            identity_key: identity.publicKey,
            wrapped_identity: await sealJwk(secret, "identity", userId, identityJwk),
            backup_public_key: backupJwk.x,
            backup_key_signature: await sign(identity.privateKey, backupKeyMessage(userId, backupJwk.x)),
            wrapped_backup_key: await sealJwk(secret, "backup-key", userId, backupJwk),
        });
        this.dropPassword();
        this.secret = secret;
        await this.store!.set("backup-secret", secret);
        this.backupKeyPair = { publicKey: backupJwk.x, keyPair: await importAgreementJwk(backupJwk) };
    }

    private async syncPassword() {
        const password = this.passwordValue();
        const backup = this.backup;
        if (!password || !this.secret || !backup) return;
        if (backup.mode !== "password") {
            this.dropPassword();
            return;
        }
        const current = backup.wrapped_secret ? await unwrapSecret(this.userId, backup, password).catch(() => null) : null;
        if (!current || !sameBytes(current, this.secret))
            this.backup = await this.api.request<BackupRecord>("patch", "/users/@me/e2ee/backup", {
                version: backup.version,
                ...(await wrapSecret(this.userId, "password", password, this.secret)),
            });
        this.dropPassword();
    }

    private async wipeLocal(keepTrust: boolean) {
        const store = this.store!;
        if (!keepTrust) await this.rememberIdentity(this.trustedKey);
        for (const name of ["identity", "device", "prekeys", "backup-secret", ...(keepTrust ? [] : ["trusted-identity"])]) await store.del(name);
        this.identity = null;
        this.device = null;
        this.prekeys = [];
        this.secret = null;
        this.backupKeyPair = null;
        this.linked = false;
        this.deviceStatus = "unregistered";
        if (!keepTrust) this.trustedKey = null;
        this.wiped = true;
    }

    async forget() {
        this.dropPassword();
        if (!this.store) return;
        await this.serialized(() => this.wipeLocal(true));
        this.wiped = false;
        this.userId = "";
        this.backup = null;
        this.devices = [];
        this.plaintext.clear();
        this.directory.clear();
        this.members.clear();
        this.emit();
    }

    private async ensureKeys() {
        const store = this.store!;
        const userId = this.userId;
        this.device = (await store.get<StoredDevice>("device")) ?? null;
        let state = await this.api.request<ServerState>("get", `/users/@me/e2ee${this.device ? `?device_id=${encodeURIComponent(this.device.deviceId)}` : ""}`);
        const revoked = this.device && state.devices.find((d) => d.device_id === this.device!.deviceId)?.status === "revoked" ? this.device.deviceId : null;
        if (revoked && (await store.get<StoredDevice>("device"))?.deviceId === revoked) await this.wipeLocal(true);
        this.encryptedChannels = new Set(state.channels);
        this.privateByDefault = state.private_by_default ?? this.privateByDefault;
        this.identity = (await store.get<StoredIdentity>("identity")) ?? null;
        this.trustedKey = (await store.get<string>("trusted-identity")) ?? null;
        this.prekeys = (await store.get<StoredPrekey[]>("prekeys")) ?? [];
        this.secret = (await store.get<Bytes>("backup-secret")) ?? null;
        if (!this.secret) this.backupKeyPair = null;
        this.backup = await this.fetchBackup();
        let identityJwk: OkpJwk | null = this.freshIdentity;
        this.freshIdentity = null;

        if (!state.identity_key) {
            identityJwk = await generateExportable("Ed25519");
            await this.adoptIdentity(identityJwk);
            state = await this.api.request<ServerState>("put", "/users/@me/e2ee/identity", {
                public_key: identityJwk.x,
            });
            this.secret = null;
            this.backupKeyPair = null;
        } else if (!this.backup && !state.channels.length && this.identity?.publicKey !== state.identity_key && this.passwordValue()) {
            const password = this.passwordValue()!;
            identityJwk = await generateExportable("Ed25519");
            state = await this.api.request<ServerState>("post", "/users/@me/e2ee/reset", {
                password,
                public_key: identityJwk.x,
            });
            await this.wipeLocal(false);
            await this.adoptIdentity(identityJwk);
            this.directory.clear();
        }
        const serverKey = state.identity_key!;
        this.serverKey = serverKey;
        this.identityCreatedAt = state.identity_created_at ? Date.parse(state.identity_created_at) : null;

        if (this.identity && this.identity.publicKey !== serverKey) {
            const previous = state.previous_identity;
            const rotated =
                previous?.public_key === this.identity.publicKey &&
                (await verify(previous.public_key, rotationMessage(userId, previous.public_key, serverKey), previous.signature));
            this.identity = null;
            await store.del("identity");
            if (rotated) await this.trust(serverKey);
        }
        if (this.identity) await this.trust(this.identity.publicKey);

        const backup = this.backup?.identity_key === serverKey ? this.backup : null;
        if (backup && this.secret && (!this.identity || !this.backupKeyPair || this.backupKeyPair.publicKey !== backup.backup_public_key)) {
            try {
                identityJwk = await this.restoreFromSecret(this.secret, backup);
            } catch (error) {
                console.error("[e2ee] stored backup secret doesn't open the backup", error);
                this.secret = null;
                this.backupKeyPair = null;
                await store.del("backup-secret");
            }
        }
        const password = this.passwordValue();
        if (backup && !this.secret && password && backup.mode === "password" && backup.wrapped_secret) {
            const secret = await unwrapSecret(userId, backup, password).catch(() => null);
            if (secret) identityJwk = await this.restoreFromSecret(secret, backup);
        }
        if (backup && !this.secret && password && this.trustsServer) {
            const secret = await this.serverSecret(password).catch(() => null);
            if (secret) identityJwk = await this.restoreFromSecret(secret, backup);
        }
        if (this.identity && !backup) {
            try {
                await this.createBackup(state, identityJwk);
            } catch (error) {
                console.error("[e2ee] couldn't create the key backup", error);
            }
        }
        await this.syncPassword().catch((error) => console.error("[e2ee] couldn't update the backup password", error));

        const trusted = this.trustedKey === state.identity_key ? this.trustedKey : null;
        let serverDevice = this.device ? state.devices.find((d) => d.device_id === this.device!.deviceId) : undefined;
        if (!this.device || serverDevice?.status === "revoked") {
            const pair = await generateSigningKey();
            const signingKey = await exportPublic(pair.publicKey);
            this.device = {
                deviceId: await deviceIdFor(signingKey),
                signingKey,
                privateKey: pair.privateKey,
            };
            this.prekeys = [];
            serverDevice = undefined;
            await store.set("device", this.device);
        }
        if (!this.prekeys.length) {
            this.prekeys = [await this.newPrekey(1)];
            await store.set("prekeys", this.prekeys);
        }

        let current = this.currentPrekey();
        if (serverDevice && Date.now() - current.createdAt > PREKEY_ROTATE_MS) {
            const next = await this.newPrekey(current.id + 1);
            current.retiredAt = Date.now();
            this.prekeys = [...this.prekeys.filter((p) => !p.retiredAt || Date.now() - p.retiredAt < PREKEY_KEEP_MS), next];
            await store.set("prekeys", this.prekeys);
            await this.api.request("put", `/users/@me/e2ee/devices/${this.device.deviceId}/prekey`, {
                id: next.id,
                public_key: next.publicKey,
                signature: next.signature,
            });
            serverDevice.prekey = { id: next.id, public_key: next.publicKey, signature: next.signature };
            current = next;
        }

        const message = deviceMessage(userId, this.device.deviceId, this.device.signingKey);
        const signedBy = async (device: ServerDevice | undefined) =>
            !!trusted && device?.status === "active" && !!device.identity_signature && (await verify(trusted, message, device.identity_signature));
        const canSign = !!this.identity && this.identity.publicKey === trusted;
        if (!serverDevice || serverDevice.prekey.id !== current.id || (canSign && !(await signedBy(serverDevice)))) {
            serverDevice = await this.api.request<ServerDevice>("post", "/users/@me/e2ee/devices", {
                device_id: this.device.deviceId,
                signing_key: this.device.signingKey,
                identity_signature: canSign ? await sign(this.identity!.privateKey, message) : undefined,
                name: deviceName(),
                prekey: { id: current.id, public_key: current.publicKey, signature: current.signature },
            });
            state.devices = [...state.devices.filter((d) => d.device_id !== serverDevice!.device_id), serverDevice];
        }
        this.devices = state.devices;
        this.deviceStatus = serverDevice.status;
        this.linked = await signedBy(serverDevice);
        this.directory.delete(userId);
        if (this.linked) await this.applyTrust(this.backup).catch((error) => console.error("[e2ee] couldn't read the synced verifications", error));
        await this.publishServerRecovery().catch(() => {});
    }

    private async applyTrust(record: BackupRecord | null, syncLocal = true) {
        const trust = record?.identity_key === this.serverKey ? record.trust : undefined;
        if (!trust || !this.secret || trust.version === this.trustVersion) return {};
        this.trustVersion = trust.version;
        const remote = trust.data ? await openTrust(this.secret, this.userId, trust.data) : {};
        let changed = false;
        for (const [userId, entry] of Object.entries(remote)) {
            const contact = this.contacts[userId];
            if (userId === this.userId || entry.at <= (contact?.verifiedAt ?? 0)) continue;
            if (!contact)
                this.contacts[userId] = {
                    identityKey: entry.key,
                    verified: entry.verified,
                    pendingKey: null,
                    firstSeen: Date.now(),
                    verifiedAt: entry.at,
                };
            else if (contact.identityKey === entry.key) Object.assign(contact, { verified: entry.verified, verifiedAt: entry.at });
            else if (contact.pendingKey === entry.key)
                Object.assign(contact, {
                    previousKeys: [...new Set([...(contact.previousKeys ?? []), contact.identityKey])].slice(-16),
                    identityKey: entry.key,
                    pendingKey: null,
                    verified: entry.verified,
                    verifiedAt: entry.at,
                });
            else continue;
            this.directory.delete(userId);
            changed = true;
        }
        if (changed) {
            await this.saveContacts();
            queueMicrotask(() => this.emit());
        }
        const unsynced = Object.keys(this.contacts).filter((id) => this.contacts[id].verified && !this.contacts[id].pendingKey && !remote[id]);
        if (syncLocal && unsynced.length) queueMicrotask(() => this.pushTrust(unsynced).catch((error) => console.error("[e2ee] couldn't sync verifications", error)));
        return remote;
    }

    async syncTrust() {
        if (!this.linked) return;
        await this.serialized(async () => {
            this.backup = await this.fetchBackup();
            await this.applyTrust(this.backup);
        });
    }

    private async pushTrust(userIds: string[]) {
        if (!this.secret) return;
        await this.serialized(async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
                const backup = (this.backup = await this.fetchBackup());
                if (!backup?.trust || backup.identity_key !== this.serverKey || !this.secret) return;
                this.trustVersion = -1;
                const remote = await this.applyTrust(backup, false).catch(() => ({}) as TrustMap);
                const next = { ...remote };
                for (const id of userIds) {
                    const contact = this.contacts[id];
                    if (!contact || contact.pendingKey) continue;
                    const at = contact.verifiedAt ?? Date.now();
                    if ((remote[id]?.at ?? 0) < at) next[id] = { key: contact.identityKey, verified: contact.verified, at };
                }
                if (userIds.every((id) => next[id] === remote[id])) return;
                try {
                    const saved = await this.api.request<{ version: number; data: string }>("put", "/users/@me/e2ee/backup/trust", {
                        version: backup.trust.version,
                        data: await sealTrust(this.secret, this.userId, next),
                    });
                    this.trustVersion = saved.version;
                    backup.trust = saved;
                    return;
                } catch (error) {
                    if ((error as { status?: number })?.status !== 409) throw error;
                }
            }
        });
    }

    async unlockWith(kind: BackupMode, input: string) {
        const backup = (this.backup = await this.fetchBackup());
        if (kind === "password" && (!backup || (backup.mode === "password" && !backup.wrapped_secret)))
            throw new E2eeError("BAD_SECRET", t("Your keys aren't backed up with your password yet."));
        if (!backup?.wrapped_secret || backup.mode !== kind) throw new E2eeError("BAD_SECRET", t("There's no backup to unlock with that"));
        const secret = await unwrapSecret(this.userId, backup, input).catch(() => null);
        if (!secret) throw new E2eeError("BAD_SECRET", kind === "password" ? t("That password didn't unlock your keys") : t("That recovery code didn't work"));
        await this.unlockWithSecret(secret);
    }

    async unlockWithSecret(secret: Bytes) {
        const backup = await this.fetchBackup();
        if (!backup || backup.identity_key !== this.serverKey) throw new E2eeError("BAD_SECRET", t("That key didn't unlock this browser"));
        await this.restoreFromSecret(secret, backup);
        await this.refresh();
        if (!this.linked) throw new E2eeError("BAD_SECRET", t("That key didn't unlock this browser"));
    }

    exportSecret() {
        return this.secret;
    }

    async useRecoveryCode() {
        const code = generateRecoveryCode();
        await this.setBackupMode("recovery", code);
        return code;
    }

    async setBackupMode(mode: BackupMode, input: string) {
        if (!this.secret) throw new E2eeError("LOCKED", t("Unlock this browser first"));
        await this.serialized(async () => {
            const backup = (this.backup = await this.fetchBackup());
            if (!backup) throw new E2eeError("LOCKED", t("There's no backup yet"));
            this.backup = await this.api.request<BackupRecord>("patch", "/users/@me/e2ee/backup", {
                version: backup.version,
                ...(await wrapSecret(this.userId, mode, input, this.secret!)),
            });
        });
        await this.publishServerRecovery().catch(() => {});
        this.emit();
    }

    async reset(password: string) {
        await this.serialized(() =>
            this.exclusive(async () => {
                const identityJwk = await generateExportable("Ed25519");
                await this.api.request("post", "/users/@me/e2ee/reset", {
                    password,
                    public_key: identityJwk.x,
                });
                await this.wipeLocal(false);
                await this.adoptIdentity(identityJwk);
                this.freshIdentity = identityJwk;
                this.backup = null;
                this.holdPassword(password);
                this.directory.clear();
            }),
        );
        await this.refresh();
    }

    async removeDevice(deviceId: string) {
        await this.api.request("del", `/users/@me/e2ee/devices/${deviceId}`);
        this.devices = this.devices.filter((d) => d.device_id !== deviceId);
        this.directory.delete(this.userId);
        this.emit();
    }

    async reloadBackup() {
        this.backup = await this.fetchBackup();
        this.emit();
        return this.backup;
    }

    invalidateUser(userId: string) {
        this.directory.delete(userId);
    }

    invalidateChannel(channelId: string) {
        this.members.delete(channelId);
    }

    invalidateAll() {
        this.directory.clear();
        this.members.clear();
    }

    setChannelEncrypted(channelId: string) {
        this.encryptedChannels.add(channelId);
        this.emit();
    }

    isEncrypted(channelId: string) {
        return this.encryptedChannels.has(channelId) || this.classifyChannel(channelId, this.privateByDefault);
    }

    channelMembers(channelId: string) {
        let pending = this.members.get(channelId);
        if (!pending) {
            pending = this.api.request<{ users: Record<string, ServerUserKeys>; channel_members?: string[] }>("post", "/e2ee/keys/query", { channel_id: channelId }).then((res) => {
                const ids = res.channel_members ?? [];
                for (const id of ids) {
                    const entry = this.verifyEntry(id, res.users[id] ?? { identity_key: null, devices: [] });
                    entry.catch(() => this.directory.delete(id));
                    this.directory.set(id, entry);
                }
                return ids.filter((id) => id !== this.userId);
            });
            pending.catch(() => this.members.delete(channelId));
            this.members.set(channelId, pending);
        }
        return pending;
    }

    profile(userId: string) {
        let pending = this.profiles.get(userId);
        if (!pending) {
            pending = this.api.request<ChannelMember>("get", `/users/${userId}`).catch(() => ({ id: userId, username: userId }));
            this.profiles.set(userId, pending);
        }
        return pending;
    }

    async keysFor(userIds: string[], force = false): Promise<DirectoryEntry[]> {
        const missing = [...new Set(userIds)].filter((id) => force || !this.directory.has(id));
        if (missing.length) {
            const batch = this.api.request<{ users: Record<string, ServerUserKeys> }>("post", "/e2ee/keys/query", { user_ids: missing });
            for (const id of missing) {
                const entry = batch.then((res) => this.verifyEntry(id, res.users[id] ?? { identity_key: null, devices: [] }));
                entry.catch(() => this.directory.delete(id));
                this.directory.set(id, entry);
            }
        }
        const entries = await Promise.all(userIds.map((id) => this.directory.get(id)!));
        const stale = entries.filter((e) => Date.now() - e.fetchedAt > DIRECTORY_TTL_MS).map((e) => e.userId);
        return stale.length && !force ? this.keysFor(userIds, true) : entries;
    }

    private async verifyEntry(userId: string, keys: ServerUserKeys): Promise<DirectoryEntry> {
        const identityKey = keys.identity_key;
        let identityChanged = false;
        if (identityKey && userId === this.userId) identityChanged = identityKey !== this.trustedKey;
        else if (identityKey) {
            const contact = this.contacts[userId];
            const previous = keys.previous_identity;
            if (!contact) {
                this.contacts[userId] = {
                    identityKey,
                    verified: false,
                    pendingKey: null,
                    firstSeen: Date.now(),
                };
                await this.saveContacts();
            } else if (
                contact.identityKey !== identityKey &&
                previous?.public_key === contact.identityKey &&
                (await verify(previous.public_key, rotationMessage(userId, previous.public_key, identityKey), previous.signature))
            ) {
                contact.previousKeys = [...new Set([...(contact.previousKeys ?? []), contact.identityKey])].slice(-16);
                contact.identityKey = identityKey;
                contact.pendingKey = null;
                await this.saveContacts();
            } else if (this.trustsServer && (contact.identityKey !== identityKey || contact.pendingKey)) {
                if (contact.identityKey !== identityKey) {
                    contact.previousKeys = [...new Set([...(contact.previousKeys ?? []), contact.identityKey])].slice(-16);
                    contact.verified = false;
                }
                contact.identityKey = identityKey;
                contact.pendingKey = null;
                await this.saveContacts();
                queueMicrotask(() => this.emit());
            } else if (contact.identityKey !== identityKey) {
                if (contact.pendingKey !== identityKey) {
                    contact.pendingKey = identityKey;
                    contact.verified = false;
                    await this.saveContacts();
                    queueMicrotask(() => this.emit());
                }
                identityChanged = true;
            }
        }
        const devices: DirectoryDevice[] = [];
        let backupKey: string | null = null;
        if (identityKey) {
            const known = this.knownKeys(userId, identityKey);
            for (const device of keys.devices) {
                if (!device.identity_signature) continue;
                if ((await deviceIdFor(device.signing_key)) !== device.device_id) continue;
                const message = deviceMessage(userId, device.device_id, device.signing_key);
                const signers = device.status === "revoked" ? known : [identityKey];
                let signed = false;
                for (const key of signers) if (!signed) signed = await verify(key, message, device.identity_signature);
                if (!signed) continue;
                if (!(await verify(device.signing_key, prekeyMessage(device.device_id, device.prekey.id, device.prekey.public_key), device.prekey.signature))) continue;
                devices.push({
                    deviceId: device.device_id,
                    signingKey: device.signing_key,
                    status: device.status,
                    name: device.name,
                    prekeyId: device.prekey.id,
                    prekeyPublic: device.prekey.public_key,
                    revokedAt: device.revoked_at ? Date.parse(device.revoked_at) : null,
                });
            }
            const backup = keys.backup_key;
            if (backup && (await verify(identityKey, backupKeyMessage(userId, backup.public_key), backup.signature))) backupKey = backup.public_key;
        }
        const identityCreatedAt = keys.identity_created_at ? Date.parse(keys.identity_created_at) : null;
        return {
            userId,
            identityKey,
            identityCreatedAt,
            identityChanged,
            backupKey,
            devices,
            fetchedAt: Date.now(),
        };
    }

    private knownKeys(userId: string, current: string) {
        if (userId === this.userId) return [current, this.trustedKey, ...this.previousIdentities].filter((key): key is string => !!key);
        const contact = this.contacts[userId];
        return [current, contact?.identityKey, ...(contact?.previousKeys ?? [])].filter((key): key is string => !!key);
    }

    async acceptIdentity(userId: string) {
        const contact = this.contacts[userId];
        if (!contact?.pendingKey) return;
        contact.previousKeys = [...new Set([...(contact.previousKeys ?? []), contact.identityKey])].slice(-16);
        contact.identityKey = contact.pendingKey;
        contact.pendingKey = null;
        contact.verified = false;
        contact.verifiedAt = Date.now();
        await this.saveContacts();
        this.directory.delete(userId);
        this.emit();
        this.pushTrust([userId]).catch((error) => console.error("[e2ee] couldn't sync the accepted safety number", error));
    }

    async setVerified(userId: string, verified: boolean) {
        const contact = this.contacts[userId];
        if (!contact) return;
        contact.verified = verified;
        contact.verifiedAt = Date.now();
        await this.saveContacts();
        this.emit();
        this.pushTrust([userId]).catch((error) => console.error("[e2ee] couldn't sync the verification", error));
    }

    async encrypt(channelId: string, payload: Payload, opts: { nonce?: string; mid?: string }): Promise<Envelope> {
        if (!this.device || !this.userId) throw new E2eeError("NOT_READY", t("Encryption is still starting up"));
        if (!this.linked) throw new E2eeError("NOT_LINKED", t("This browser isn't unlocked for encrypted messages yet"));
        const members = [this.userId, ...(await this.channelMembers(channelId))];
        const entries = await this.keysFor(members);
        const targets: { userId: string; device: DirectoryDevice }[] = [];
        for (const entry of entries) {
            if (entry.identityChanged) throw new E2eeError("IDENTITY_CHANGED", "A safety number changed", entry.userId);
            const active = entry.devices.filter((d) => d.status === "active");
            if (!active.length) throw new E2eeError("NO_DEVICES", "A member has no encryption keys yet", entry.userId);
            active.forEach((device) => targets.push({ userId: entry.userId, device }));
        }
        if (!targets.some((t) => t.device.deviceId === this.device!.deviceId)) {
            const current = this.currentPrekey();
            targets.push({
                userId: this.userId,
                device: {
                    deviceId: this.device.deviceId,
                    signingKey: this.device.signingKey,
                    status: "active",
                    name: null,
                    prekeyId: current.id,
                    prekeyPublic: current.publicKey,
                    revokedAt: null,
                },
            });
        }

        const bind = binding(opts.mid, opts.nonce);
        const aad = messageAad(channelId, this.userId, this.device.deviceId, bind);
        const contentKey = randomBytes(32);
        const iv = randomBytes(12);
        const ct = await aesEncrypt(contentKey, iv, utf8(JSON.stringify(payload)), aad);
        const keys = await Promise.all(
            targets.map(async ({ userId, device }) => ({
                user_id: userId,
                device_id: device.deviceId,
                prekey_id: device.prekeyId,
                ...(await hpkeSeal(device.prekeyPublic, contentKey, WRAP_INFO, `${aad}\n${device.deviceId}`)),
            })),
        );
        const backup = await Promise.all(
            entries
                .filter((e) => e.backupKey)
                .map(async (e) => ({
                    user_id: e.userId,
                    ...(await hpkeSeal(e.backupKey!, contentKey, BACKUP_INFO, `${aad}\nbackup:${e.userId}`)),
                })),
        );
        const unsigned = {
            v: 1,
            alg: ALGORITHM,
            sender_device: this.device.deviceId,
            ...(opts.mid ? { mid: opts.mid } : {}),
            iv: toB64u(iv),
            ct: toB64u(ct),
            keys,
            ...(backup.length ? { backup } : {}),
        };
        const sig = await sign(this.device.privateKey, signedPayload(channelId, this.userId, bind, unsigned));
        const envelope = { ...unsigned, sig };
        this.plaintext.set(`${opts.mid ?? ""}:${sig}`, parsePayload(JSON.parse(JSON.stringify(payload))));
        return envelope;
    }

    cached(message: RawMessage) {
        const env = message.encrypted;
        return env ? (this.plaintext.get(`${message.id}:${env.sig}`) ?? this.plaintext.get(`${env.mid ?? ""}:${env.sig}`)) : undefined;
    }

    async decrypt(message: RawMessage, remember = true): Promise<Payload> {
        const env = message.encrypted;
        if (!env || env.v !== 1 || env.alg !== ALGORITHM || !Array.isArray(env.keys)) throw new E2eeError("BAD_ENVELOPE", "Unsupported envelope");
        const hit = this.cached(message);
        if (remember && hit !== undefined) {
            this.plaintext.set(`${message.id}:${env.sig}`, hit);
            return hit;
        }
        if (!this.device) throw new E2eeError("NOT_READY", t("Encryption is still starting up"));
        const senderId = message.author?.id;
        if (!senderId) throw new E2eeError("BAD_ENVELOPE", "Missing author");
        if (env.mid && env.mid !== message.id) throw new E2eeError("BAD_ENVELOPE", "Envelope belongs to another message");
        const nonce = message.nonce == null ? undefined : String(message.nonce);
        if (!env.mid && !nonce) throw new E2eeError("BAD_ENVELOPE", "Missing nonce");

        let [entry] = await this.keysFor([senderId]);
        let sender = entry.devices.find((d) => d.deviceId === env.sender_device);
        if (!sender && Date.now() - entry.fetchedAt > 3000) {
            [entry] = await this.keysFor([senderId], true);
            sender = entry.devices.find((d) => d.deviceId === env.sender_device);
        }
        const sentAt = snowflakeTime(message.id);
        if (!sender) {
            if (entry.identityCreatedAt && sentAt < entry.identityCreatedAt) throw new E2eeError("RESET", t("Sent before encryption was reset"));
            throw new E2eeError("BAD_SIGNATURE", t("The sender's device couldn't be verified"));
        }
        if (sender.status === "revoked" && (!sender.revokedAt || sentAt >= sender.revokedAt)) throw new E2eeError("BAD_SIGNATURE", t("Sent from a device that was removed"));
        const bind = binding(env.mid, nonce);
        const { sig, ...unsigned } = env;
        if (!(await verify(sender.signingKey, signedPayload(message.channel_id, senderId, bind, unsigned), sig))) throw new E2eeError("BAD_SIGNATURE", t("Signature check failed"));

        const aad = messageAad(message.channel_id, senderId, env.sender_device, bind);
        const mine = env.keys.find((k) => k.device_id === this.device!.deviceId);
        const prekey = mine && this.prekeys.find((p) => p.id === mine.prekey_id);
        let contentKey: Bytes | null = null;
        if (mine && prekey) contentKey = await hpkeOpen(prekey.keyPair, mine.enc, mine.wrapped, WRAP_INFO, `${aad}\n${mine.device_id}`);
        const backupEntry = env.backup?.find((b) => b.user_id === this.userId);
        const backupKey = this.backupKeyPair;
        if (!contentKey && backupEntry && backupKey)
            contentKey = await hpkeOpen(backupKey.keyPair, backupEntry.enc, backupEntry.wrapped, BACKUP_INFO, `${aad}\nbackup:${this.userId}`).catch(() => null);
        if (!contentKey && backupKey) {
            const stored = await this.lookupStoredKey(message.id);
            if (stored) contentKey = await hpkeOpen(backupKey.keyPair, stored.enc, stored.wrapped, BACKUP_INFO, storedKeyAad(this.userId, message.id, sig)).catch(() => null);
        }
        if (!contentKey) {
            if (!this.linked || !backupKey) throw new E2eeError("LOCKED", t("This browser isn't unlocked yet"));
            if (this.identityCreatedAt && sentAt < this.identityCreatedAt) throw new E2eeError("RESET", t("Sent before encryption was reset"));
            throw new E2eeError("NO_KEY", t("Sent before this browser was set up"));
        }
        const payload = parsePayload(JSON.parse(fromUtf8(await aesDecrypt(contentKey, fromB64u(env.iv), fromB64u(env.ct), aad))));
        if (mine && prekey && backupKey) {
            const covered =
                !!backupEntry && !!(await hpkeOpen(backupKey.keyPair, backupEntry.enc, backupEntry.wrapped, BACKUP_INFO, `${aad}\nbackup:${this.userId}`).catch(() => null));
            if (!covered) await this.queueBackup(message.id, sig, contentKey);
        }
        if (remember) this.plaintext.set(`${message.id}:${env.sig}`, payload);
        return payload;
    }

    private lookupStoredKey(messageId: string) {
        const known = this.storedKeys.get(messageId);
        if (known) return Promise.resolve(known);
        const existing = this.lookups.get(messageId);
        if (existing) return existing.promise;
        let resolve: (value: EnvelopeBackupKey | null) => void = () => {};
        const promise = new Promise<EnvelopeBackupKey | null>((r) => {
            resolve = r;
        });
        this.lookups.set(messageId, { promise, resolve });
        this.lookupTimer ??= setTimeout(() => this.flushLookups(), 25);
        return promise;
    }

    private async flushLookups() {
        this.lookupTimer = null;
        const batch = [...this.lookups.entries()].slice(0, 100);
        batch.forEach(([id]) => this.lookups.delete(id));
        if (this.lookups.size) this.lookupTimer = setTimeout(() => this.flushLookups(), 0);
        try {
            const res = await this.api.request<{
                keys: { message_id: string; enc: string; wrapped: string }[];
            }>("post", "/users/@me/e2ee/backup/keys/query", {
                message_ids: batch.map(([id]) => id),
            });
            for (const key of res.keys)
                this.storedKeys.set(key.message_id, {
                    user_id: this.userId,
                    enc: key.enc,
                    wrapped: key.wrapped,
                });
        } catch (error) {
            console.error("[e2ee] backup key lookup failed", error);
        }
        batch.forEach(([id, { resolve }]) => resolve(this.storedKeys.get(id) ?? null));
    }

    private async queueBackup(messageId: string, sig: string, contentKey: Bytes) {
        const marker = `bk:${messageId}`;
        if (this.uploads.has(messageId) || (await this.store!.get<string>(marker)) === sig || !this.backupKeyPair) return;
        const sealed = await hpkeSeal(this.backupKeyPair.publicKey, contentKey, BACKUP_INFO, storedKeyAad(this.userId, messageId, sig));
        this.uploads.set(messageId, { message_id: messageId, ...sealed, sig });
        this.uploadTimer ??= setTimeout(() => this.flushBackups(), 1000);
    }

    async flushBackups() {
        if (this.uploadTimer) clearTimeout(this.uploadTimer);
        this.uploadTimer = null;
        while (this.uploads.size) {
            const batch = [...this.uploads.values()].slice(0, 100);
            batch.forEach((entry) => this.uploads.delete(entry.message_id));
            try {
                await this.api.request("post", "/users/@me/e2ee/backup/keys", {
                    keys: batch.map(({ message_id, enc, wrapped }) => ({ message_id, enc, wrapped })),
                });
                await Promise.all(batch.map((entry) => this.store!.set(`bk:${entry.message_id}`, entry.sig)));
            } catch (error) {
                console.error("[e2ee] backup upload failed", error);
                return;
            }
        }
    }

    private async backfill() {
        const key = this.backupKeyPair?.publicKey;
        if (!key || this.backfilling) return;
        const marker = `backfill:${key}`;
        if (await this.store!.get<boolean>(marker)) return;
        this.backfilling = true;
        try {
            for (const channelId of [...this.encryptedChannels]) {
                let before = "";
                for (let page = 0; page < 50; page++) {
                    const batch = await this.api.request<RawMessage[]>("get", `/channels/${channelId}/messages?limit=100${before && `&before=${before}`}`);
                    for (const message of batch) if (message.encrypted) await this.decrypt(message, false).catch(() => {});
                    await this.flushBackups();
                    if (batch.length < 100) break;
                    before = batch[batch.length - 1].id;
                    await sleep(250);
                }
            }
            await this.store!.set(marker, true);
        } finally {
            this.backfilling = false;
        }
    }

    async safetyNumber(userId: string) {
        const [entry] = await this.keysFor([userId]);
        const theirs = this.contacts[userId]?.pendingKey ?? entry.identityKey;
        const mine = this.trustedKey;
        if (!theirs || !mine) return null;
        const part = async (id: string, key: string) => {
            let digest = new Uint8Array(await crypto.subtle.digest("SHA-512", new Uint8Array([0, 0, ...fromB64u(key), ...utf8(id)])));
            for (let i = 0; i < 5200; i++) digest = new Uint8Array(await crypto.subtle.digest("SHA-512", new Uint8Array([...digest, ...fromB64u(key)])));
            let out = "";
            for (let i = 0; i < 30; i += 5) {
                const chunk = digest.subarray(i, i + 5).reduce((acc, byte) => acc * 256 + byte, 0);
                out += String(chunk % 100000).padStart(5, "0");
            }
            return out;
        };
        const [own, other] = await Promise.all([part(this.userId, mine), part(userId, theirs)]);
        return own < other ? own + other : other + own;
    }
}
