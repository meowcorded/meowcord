import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, hkdfSync, KeyObject, randomBytes, sign, verify } from "node:crypto";
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { E2eeDevice, E2eeIdentity, getDatabase, User } from "@spacebar/database";
import { E2eeEnvelope, UserFlags } from "@spacebar/schemas";
import { e2eeBackupKeyMessage, e2eeDeviceId, e2eeDeviceMessage, e2eeLimits, e2eePrekeyMessage, e2eeUserKeys } from "./e2ee";

const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
});
const senderFlights = new Map<string, Promise<ManagedSender>>();
const directory = () => process.env.E2EE_SYSTEM_KEY_DIR || path.join(path.dirname(path.resolve(process.env.CONFIG_PATH || "config.json")), ".e2ee-system");
const keyUnavailable = () => new Error("System sender encryption keys are unavailable; restore the instance key files");

export class SystemRecipientNotReady extends Error {
    constructor() {
        super("Recipient encryption is not ready yet");
    }
}

export interface SystemFileMeta {
    name: string;
    filename: string;
    content_type: string;
    size: number;
    key: string;
    iv: string;
}
// a safety card the client draws after decrypting; only these embed types are ever put in a payload
export interface SystemCardEmbed {
    type: "safety_system_notification" | "safety_policy_notice";
    fields: { name: string; value: string }[];
}
export interface SystemPayload {
    content: string;
    attachments?: SystemFileMeta[];
    embeds?: SystemCardEmbed[];
}
export interface EncryptedSystemFile {
    fieldname: string;
    originalname: string;
    mimetype: string;
    buffer: Buffer;
    meta: SystemFileMeta;
}
interface ManagedSender {
    deviceId: string;
    signing: KeyObject;
    identityPublic: string;
    signingPublic: string;
    prekeyPublic: string;
}

const publicRaw = (key: KeyObject) => String(createPublicKey(key).export({ format: "jwk" }).x);
const privateKey = (seed: Buffer, label: string, curve: "Ed25519" | "X25519") => {
    const secret = Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(32), `fosscord-e2ee/v1/system-sender/${label}`, 32));
    try {
        const prefix = Buffer.from(curve === "Ed25519" ? "302e020100300506032b657004220420" : "302e020100300506032b656e04220420", "hex");
        return createPrivateKey({ key: Buffer.concat([prefix, secret]), format: "der", type: "pkcs8" });
    } finally {
        secret.fill(0);
    }
};
const signature = (key: KeyObject, message: string) => sign(null, Buffer.from(message), key).toString("base64url");
const verifyRaw = (publicKey: string, message: string, sig: string) => {
    try {
        const key = createPublicKey({
            key: { kty: "OKP", crv: "Ed25519", x: publicKey },
            format: "jwk",
        });
        return verify(null, Buffer.from(message), key, Buffer.from(sig, "base64url"));
    } catch {
        return false;
    }
};
const readSeed = async (filename: string) => {
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 128) throw keyUnavailable();
        const encoded = (await file.readFile("utf8")).trim();
        const seed = Buffer.from(encoded, "base64url");
        if (seed.length !== 32 || seed.toString("base64url") !== encoded) throw keyUnavailable();
        return seed;
    } finally {
        await file.close();
    }
};
const loadSeed = async (userId: string) => {
    const filename = path.join(directory(), `${userId}.key`);
    try {
        const folder = await fs.lstat(directory());
        if (!folder.isDirectory() || folder.isSymbolicLink() || folder.mode & 0o077) throw keyUnavailable();
        return await readSeed(filename);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw keyUnavailable();
    }
    if ((await E2eeIdentity.exists({ where: { user_id: userId } })) || (await E2eeDevice.exists({ where: { user_id: userId } }))) throw keyUnavailable();
    await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory());
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw keyUnavailable();
    const temporary = `${filename}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
    const seed = randomBytes(32);
    try {
        const file = await fs.open(temporary, "wx", 0o600);
        try {
            await file.writeFile(`${seed.toString("base64url")}\n`, "utf8");
            await file.sync();
        } finally {
            await file.close();
        }
        try {
            await fs.link(temporary, filename);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const folder = await fs.open(directory(), constants.O_RDONLY);
        try {
            await folder.sync();
        } finally {
            await folder.close();
        }
        return await readSeed(filename);
    } finally {
        seed.fill(0);
        await fs.unlink(temporary).catch(() => undefined);
    }
};

const registerSender = async (sender: User): Promise<ManagedSender> => {
    if (!/^\d{1,20}$/.test(sender.id) || !["official", "appeals"].includes(sender.username) || !(BigInt(sender.flags ?? 0) & UserFlags.FLAGS.SYSTEM)) throw keyUnavailable();
    const seed = await loadSeed(sender.id);
    const identity = privateKey(seed, "identity", "Ed25519");
    const signing = privateKey(seed, "device", "Ed25519");
    const prekey = privateKey(seed, "prekey", "X25519");
    seed.fill(0);
    const identityPublic = publicRaw(identity);
    const signingPublic = publicRaw(signing);
    const prekeyPublic = publicRaw(prekey);
    const deviceId = e2eeDeviceId(signingPublic);
    const database = getDatabase();
    if (!database) throw keyUnavailable();
    await database.transaction(async (manager) => {
        await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`e2ee-system-sender:${sender.id}`]);
        const identities = manager.getRepository(E2eeIdentity);
        const devices = manager.getRepository(E2eeDevice);
        const known = await identities.findOne({ where: { user_id: sender.id } });
        if (known && known.public_key !== identityPublic) throw keyUnavailable();
        if (!known)
            await identities.insert({
                user_id: sender.id,
                public_key: identityPublic,
                previous_key: null,
                rotation_signature: null,
                created_at: new Date(),
            });
        const device = await devices.findOne({ where: { id: deviceId } });
        if (device && (device.user_id !== sender.id || device.status !== "active" || device.signing_key !== signingPublic || device.prekey_public !== prekeyPublic))
            throw keyUnavailable();
        if (!device)
            await devices.insert({
                id: deviceId,
                user_id: sender.id,
                signing_key: signingPublic,
                identity_signature: signature(identity, e2eeDeviceMessage(sender.id, deviceId, signingPublic)),
                status: "active",
                name: "Instance system sender",
                prekey_id: 1,
                prekey_public: prekeyPublic,
                prekey_signature: signature(signing, e2eePrekeyMessage(deviceId, 1, prekeyPublic)),
                prekey_updated_at: new Date(),
                created_at: new Date(),
                revoked_at: null,
                session_id: null,
            });
    });
    return { deviceId, signing, identityPublic, signingPublic, prekeyPublic };
};
export const ensureSystemSender = async (sender: User) => {
    let flight = senderFlights.get(sender.id);
    if (!flight) {
        flight = registerSender(sender).finally(() => senderFlights.delete(sender.id));
        senderFlights.set(sender.id, flight);
    }
    return flight;
};

const seal = async (publicKey: string, key: Buffer, info: string, aad: string) => {
    const recipientPublicKey = await suite.kem.deserializePublicKey(Buffer.from(publicKey, "base64url"));
    const { ct, enc } = await suite.seal({ recipientPublicKey, info: Buffer.from(info) }, key, Buffer.from(aad));
    return {
        enc: Buffer.from(enc).toString("base64url"),
        wrapped: Buffer.from(ct).toString("base64url"),
    };
};
export const encryptSystemPayload = async (sender: User, members: string[], channelId: string, nonce: string, payload: SystemPayload): Promise<E2eeEnvelope> => {
    const managed = await ensureSystemSender(sender);
    const ids = [...new Set([sender.id, ...members])];
    const directory = await e2eeUserKeys(ids);
    const targets: { userId: string; deviceId: string; prekeyId: number; publicKey: string }[] = [];
    const backups: { userId: string; publicKey: string }[] = [];
    for (const id of ids) {
        const keys = directory[id];
        const active = keys?.devices.filter((device) => device.status === "active") ?? [];
        if (!keys?.identity_key || !active.length) throw new SystemRecipientNotReady();
        for (const device of active) {
            if (
                device.device_id !== e2eeDeviceId(device.signing_key) ||
                !device.identity_signature ||
                !verifyRaw(keys.identity_key, e2eeDeviceMessage(id, device.device_id, device.signing_key), device.identity_signature) ||
                !verifyRaw(device.signing_key, e2eePrekeyMessage(device.device_id, device.prekey.id, device.prekey.public_key), device.prekey.signature)
            )
                throw new Error("Recipient encryption keys could not be verified");
            targets.push({
                userId: id,
                deviceId: device.device_id,
                prekeyId: device.prekey.id,
                publicKey: device.prekey.public_key,
            });
        }
        if (keys.backup_key && verifyRaw(keys.identity_key, e2eeBackupKeyMessage(id, keys.backup_key.public_key), keys.backup_key.signature))
            backups.push({ userId: id, publicKey: keys.backup_key.public_key });
    }
    if (targets.length > e2eeLimits().maxEnvelopeDevices) throw new Error("Too many active recipient encryption devices");
    const bind = `n:${nonce}`;
    const aad = `fosscord-e2ee/v1/msg\n${channelId}\n${sender.id}\n${managed.deviceId}\n${bind}`;
    const key = randomBytes(32);
    try {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(aad));
        const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
        const keys = await Promise.all(
            targets.map(async (target) => ({
                user_id: target.userId,
                device_id: target.deviceId,
                prekey_id: target.prekeyId,
                ...(await seal(target.publicKey, key, "fosscord-e2ee/v1/wrap", `${aad}\n${target.deviceId}`)),
            })),
        );
        const backup = await Promise.all(
            backups.map(async (target) => ({
                user_id: target.userId,
                ...(await seal(target.publicKey, key, "fosscord-e2ee/v1/backup-wrap", `${aad}\nbackup:${target.userId}`)),
            })),
        );
        const unsigned = {
            v: 1,
            alg: "x25519-hpke-aes256gcm-ed25519",
            sender_device: managed.deviceId,
            iv: iv.toString("base64url"),
            ct,
            keys,
            ...(backup.length ? { backup } : {}),
        };
        const signed: unknown[] = [
            "fosscord-e2ee/v1/sig",
            channelId,
            sender.id,
            bind,
            unsigned.v,
            unsigned.alg,
            unsigned.sender_device,
            null,
            unsigned.iv,
            unsigned.ct,
            [...keys].sort((a, b) => (a.device_id < b.device_id ? -1 : 1)).map((entry) => [entry.user_id, entry.device_id, entry.prekey_id, entry.enc, entry.wrapped]),
        ];
        if (unsigned.backup) signed.push([...unsigned.backup].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)).map((entry) => [entry.user_id, entry.enc, entry.wrapped]));
        return { ...unsigned, sig: signature(managed.signing, JSON.stringify(signed)) };
    } finally {
        key.fill(0);
    }
};

export const encryptSystemFiles = (files: Pick<Express.Multer.File, "fieldname" | "originalname" | "mimetype" | "buffer">[]): EncryptedSystemFile[] =>
    files.map((file, index) => {
        const key = randomBytes(32);
        const iv = randomBytes(12);
        const filename = `${randomBytes(16).toString("hex")}.bin`;
        const parts: Buffer[] = [];
        const count = Math.max(1, Math.ceil(file.buffer.length / 65536));
        for (let chunk = 0; chunk < count; chunk++) {
            const nonce = Buffer.from(iv);
            nonce.writeUInt32BE((nonce.readUInt32BE(8) ^ chunk) >>> 0, 8);
            const cipher = createCipheriv("aes-256-gcm", key, nonce);
            cipher.setAAD(Buffer.from(`fosscord-e2ee/v1/file\n${chunk}\n${chunk === count - 1 ? 1 : 0}`));
            parts.push(Buffer.concat([cipher.update(file.buffer.subarray(chunk * 65536, (chunk + 1) * 65536)), cipher.final(), cipher.getAuthTag()]));
        }
        const meta = {
            name: filename,
            filename: file.originalname.slice(0, 200),
            content_type: file.mimetype,
            size: file.buffer.length,
            key: key.toString("base64url"),
            iv: iv.toString("base64url"),
        };
        key.fill(0);
        return {
            fieldname: `files[${index}]`,
            originalname: filename,
            mimetype: "application/octet-stream",
            buffer: Buffer.concat(parts),
            meta,
        };
    });

export async function sealSystemSpool(sender: User, announcementId: string, value: string): Promise<Buffer> {
    await ensureSystemSender(sender);
    const seed = await loadSeed(sender.id);
    const key = Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(32), "fosscord-e2ee/v1/announcement-spool", 32));
    seed.fill(0);
    try {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(announcementId));
        return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    } finally {
        key.fill(0);
    }
}
export async function openSystemSpool(sender: User, announcementId: string, value: Buffer): Promise<string> {
    const seed = await loadSeed(sender.id);
    const key = Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(32), "fosscord-e2ee/v1/announcement-spool", 32));
    seed.fill(0);
    try {
        const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
        cipher.setAAD(Buffer.from(announcementId));
        cipher.setAuthTag(value.subarray(-16));
        return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString("utf8");
    } finally {
        key.fill(0);
    }
}
