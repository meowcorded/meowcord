import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { verifyToken } from "node-2fa";
import { In } from "typeorm";
import { BackupCode, RateLimit, SecurityKey, Session, User, generateMfaBackupCodes, getDatabase } from "@spacebar/database";
import { EVENT, Event, JwtKeypairManager, UserUpdateEvent, emitEvent, generateToken } from "@spacebar/util";
import { PrivateUserProjection, UserFlags } from "@spacebar/schemas";
import { revokeStaleE2eeDevices } from "./e2ee";
import { PhoneVerification } from "./phoneVerification";
import { consumeMfaTicket, reserveMfaAttempt } from "./mfaAttempt";

export class ResponseError extends Error {
    constructor(
        public status: number,
        public body: Record<string, unknown>,
    ) {
        super(String(body.message ?? status));
        this.name = "ResponseError";
    }
}

export const MfaInvalidCode = () => new ResponseError(400, { message: "Invalid two-factor code", code: 60008 });
export const MfaInvalidTicket = () => new ResponseError(400, { message: "Invalid two-factor auth ticket", code: 60006 });

type Ticket = { typ: string; uid?: string; ch?: string; origin?: string; [key: string]: unknown };

export const signTicket = (payload: Ticket, expiresIn = 300) => jwt.sign(payload, JwtKeypairManager.keypair.privateKey, { algorithm: "ES512", expiresIn });

export function readTicket<T extends Ticket = Ticket>(token: unknown, typ: string): T | null {
    if (typeof token !== "string" || !token || token.length > 4096) return null;
    try {
        const decoded = jwt.verify(token, JwtKeypairManager.keypair.publicKey, {
            algorithms: ["ES512"],
        }) as T;
        return decoded.typ === typ ? decoded : null;
    } catch {
        return null;
    }
}

export const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");

export function requestOrigin(req: Request) {
    const origin = req.headers.origin;
    if (origin && origin !== "null") return origin;
    return `${req.protocol}://${req.get("host")}`;
}

const rpIdFor = (origin: string) => new URL(origin).hostname;

export async function guardedMfaAttempt(ticket: string, verify: () => Promise<boolean>) {
    let decoded: Ticket;
    try {
        decoded = jwt.verify(ticket, JwtKeypairManager.keypair.publicKey, { algorithms: ["ES512"] }) as Ticket;
    } catch {
        throw MfaInvalidTicket();
    }
    if (typeof decoded.exp !== "number" || decoded.exp * 1000 <= Date.now()) throw MfaInvalidTicket();
    const database = getDatabase();
    if (!database) throw new Error("MFA attempt storage is unavailable");
    const hash = await reserveMfaAttempt(database, ticket, decoded.exp * 1000);
    if (!hash) throw MfaInvalidTicket();
    if (!(await verify())) return false;
    if (!(await consumeMfaTicket(database, hash))) throw MfaInvalidTicket();
    return true;
}

export const DIRECT_CODE_ATTEMPTS = 10;
export const DIRECT_CODE_WINDOW_SECONDS = 15 * 60;

export async function throttledCodeAttempt(user_id: string, verify: () => boolean | Promise<boolean>) {
    const { hits } = await RateLimit.hit(`${user_id}:direct-mfa-code`, user_id, DIRECT_CODE_ATTEMPTS, DIRECT_CODE_WINDOW_SECONDS);
    if (hits > DIRECT_CODE_ATTEMPTS) return false;
    return verify();
}

export function verifyTotp(secret: string | undefined, code: unknown) {
    if (!secret || typeof code !== "string") return false;
    const result = verifyToken(secret, code.replace(/\s/g, ""), 1);
    return !!result && Math.abs(result.delta) <= 1;
}

export async function consumeBackupCode(user_id: string, code: unknown) {
    if (typeof code !== "string") return false;
    const result = await BackupCode.createQueryBuilder()
        .update()
        .set({ consumed: true })
        .where("user_id = :user_id", { user_id })
        .andWhere("code = :code", { code: code.replace(/[\s-]/g, "").toLowerCase() })
        .andWhere("expired = :expired AND consumed = :consumed", { expired: false, consumed: false })
        .execute();
    return result.affected === 1;
}

export const authenticatorTypes = (user_id: string) => SecurityKey.authenticatorTypes(user_id);

export const hasSmsFlag = (flags: unknown) => (BigInt(String(flags ?? 0)) & UserFlags.FLAGS.MFA_SMS) === UserFlags.FLAGS.MFA_SMS;

export async function smsPhone(user_id: string) {
    const user = await User.findOne({
        where: { id: user_id },
        select: { id: true, flags: true, phone: true, mfa_enabled: true, totp_secret: true },
    });
    if (!user?.phone || !user.mfa_enabled || !user.totp_secret || !hasSmsFlag(user.flags)) return null;
    return user.phone;
}

export async function setSmsFlag(user_id: string, enabled: boolean) {
    const user = await User.findOneOrFail({
        where: { id: user_id },
        select: { id: true, flags: true },
    });
    const flags = BigInt(String(user.flags ?? 0));
    const next = enabled ? flags | UserFlags.FLAGS.MFA_SMS : flags & ~UserFlags.FLAGS.MFA_SMS;
    if (next === flags) return false;
    await User.update({ id: user_id }, { flags: Number(next) });
    return true;
}

export const redactPhone = (phone: string) => `+${"*".repeat(Math.max(phone.length - 5, 0))}${phone.slice(-4)}`;

export function assertionOptions(origin: string, credentials: SecurityKey[], userVerification = "preferred", mediation?: string) {
    const challenge = b64url(crypto.randomBytes(32));
    const options = {
        publicKey: {
            challenge,
            timeout: 60000,
            rpId: rpIdFor(origin),
            allowCredentials: credentials.map((key) => ({
                type: "public-key",
                id: Buffer.from(key.key_id, "base64").toString("base64url"),
            })),
            userVerification,
        },
        ...(mediation ? { mediation } : {}),
    };
    return { challenge, options: JSON.stringify(options) };
}

export async function creationOptions(origin: string, user: User) {
    const challenge = b64url(crypto.randomBytes(32));
    const existing = await SecurityKey.find({ where: { user_id: user.id } });
    const options = {
        publicKey: {
            challenge,
            timeout: 60000,
            rp: { id: rpIdFor(origin), name: "Discord" },
            user: { id: b64url(Buffer.from(user.id)), name: user.username, displayName: user.username },
            pubKeyCredParams: [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -8 },
                { type: "public-key", alg: -257 },
            ],
            excludeCredentials: existing.map((key) => ({
                type: "public-key",
                id: Buffer.from(key.key_id, "base64").toString("base64url"),
            })),
            authenticatorSelection: {
                residentKey: "preferred",
                requireResidentKey: false,
                userVerification: "preferred",
            },
            attestation: "none",
        },
    };
    return { challenge, options: JSON.stringify(options) };
}

type CredentialJson = {
    id?: string;
    rawId?: string;
    response?: {
        clientDataJSON?: string;
        authenticatorData?: string;
        signature?: string;
        userHandle?: string;
        publicKey?: string;
        publicKeyAlgorithm?: number;
    };
};

function parseCredential(credential: unknown): CredentialJson | null {
    if (typeof credential === "object" && credential) return credential as CredentialJson;
    if (typeof credential !== "string" || credential.length > 16384) return null;
    try {
        return JSON.parse(credential);
    } catch {
        return null;
    }
}

function checkClientData(clientDataJSON: string, type: string, challenge: string, origin: string) {
    const raw = Buffer.from(clientDataJSON, "base64url");
    const data = JSON.parse(raw.toString("utf8"));
    if (data.type !== type || data.challenge !== challenge || data.origin !== origin) return null;
    return raw;
}

const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;

function checkAuthData(authData: Buffer, origin: string, requireUserVerification = false) {
    if (authData.length < 37) return false;
    const rpIdHash = crypto.createHash("sha256").update(rpIdFor(origin)).digest();
    if (!rpIdHash.equals(authData.subarray(0, 32))) return false;
    const required = requireUserVerification ? USER_PRESENT | USER_VERIFIED : USER_PRESENT;
    return (authData[32] & required) === required;
}

export function verifyAttestation(credential: unknown, challenge: string, origin: string) {
    const cred = parseCredential(credential);
    const response = cred?.response;
    if (!cred?.rawId || !response?.clientDataJSON || !response.authenticatorData || !response.publicKey) return null;
    try {
        if (!checkClientData(response.clientDataJSON, "webauthn.create", challenge, origin)) return null;
        const authData = Buffer.from(response.authenticatorData, "base64url");
        if (!checkAuthData(authData, origin)) return null;
        const publicKey = crypto.createPublicKey({
            key: Buffer.from(response.publicKey, "base64url"),
            format: "der",
            type: "spki",
        });
        return {
            key_id: Buffer.from(cred.rawId, "base64url").toString("base64"),
            public_key: publicKey.export({ format: "pem", type: "spki" }).toString(),
            counter: authData.readUInt32BE(33),
        };
    } catch {
        return null;
    }
}

export async function findCredential(credential: unknown, user_id?: string) {
    const cred = parseCredential(credential);
    if (!cred?.rawId) return null;
    const raw = Buffer.from(cred.rawId, "base64url");
    return SecurityKey.findOne({
        where: {
            key_id: In([raw.toString("base64"), raw.toString("base64url")]),
            ...(user_id ? { user_id } : {}),
        },
    });
}

export async function verifyAssertion(credential: unknown, challenge: string, origin: string, key: SecurityKey, requireUserVerification = false) {
    const cred = parseCredential(credential);
    const response = cred?.response;
    if (!response?.clientDataJSON || !response.authenticatorData || !response.signature) return false;
    try {
        const clientData = checkClientData(response.clientDataJSON, "webauthn.get", challenge, origin);
        if (!clientData) return false;
        const authData = Buffer.from(response.authenticatorData, "base64url");
        if (!checkAuthData(authData, origin, requireUserVerification)) return false;
        const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
        const publicKey = crypto.createPublicKey(key.public_key);
        const signature = Buffer.from(response.signature, "base64url");
        const valid =
            publicKey.asymmetricKeyType === "ed25519"
                ? crypto.verify(null, signed, publicKey, signature)
                : crypto.verify("sha256", signed, { key: publicKey, dsaEncoding: "der" }, signature);
        if (!valid) return false;
        const counter = authData.readUInt32BE(33);
        if (counter !== 0 || key.counter !== 0) {
            if (counter <= key.counter) return false;
        }
        key.counter = counter;
        await key.save();
        return true;
    } catch {
        return false;
    }
}

export async function mfaChallenge(req: Request, user_id: string) {
    const user = await User.findOneOrFail({
        where: { id: user_id },
        select: { id: true, mfa_enabled: true, totp_secret: true, data: true },
    });
    const keys = await SecurityKey.find({ where: { user_id } });
    const origin = requestOrigin(req);
    const methods: Record<string, unknown>[] = [];
    let ch: string | undefined;
    if (keys.length) {
        const { challenge, options } = assertionOptions(origin, keys);
        ch = challenge;
        methods.push({ type: "webauthn", challenge: options });
    }
    if (user.mfa_enabled && user.totp_secret) methods.push({ type: "totp", backup_codes_allowed: true });
    if (await smsPhone(user_id)) methods.push({ type: "sms" });
    if (methods.length) methods.push({ type: "backup" });
    else if (user.data?.hash) methods.push({ type: "password" });
    return { ticket: signTicket({ typ: "mfa", uid: user_id, ch, origin }), methods };
}

export const FAILED_CODE_ATTEMPTS = 20;
export const FAILED_CODE_WINDOW_SECONDS = 15 * 60;
const GUESSABLE_METHODS = new Set(["totp", "backup", "sms", "password"]);
const failedCodeKey = (user_id: string) => `${user_id}:failed-mfa-code`;

export async function verifyMfaMethod(user_id: string, type: string, data: unknown, ticket: Ticket) {
    if (ticket.uid !== user_id || (ticket.typ !== "login" && ticket.typ !== "mfa")) return false;
    if (typeof data === "string" && data.length > 16384) return false;
    if (!GUESSABLE_METHODS.has(type)) return checkMfaMethod(user_id, type, data, ticket);
    const attempt = await RateLimit.hit(failedCodeKey(user_id), user_id, FAILED_CODE_ATTEMPTS + 1, FAILED_CODE_WINDOW_SECONDS);
    if (attempt.hits > FAILED_CODE_ATTEMPTS) return false;
    if (!(await checkMfaMethod(user_id, type, data, ticket))) return false;
    await RateLimit.query(`UPDATE rate_limits SET hits = hits - 1 WHERE id = $1 AND hits > 0`, [failedCodeKey(user_id)]);
    return true;
}

async function checkMfaMethod(user_id: string, type: string, data: unknown, ticket: Ticket) {
    if (type === "totp" || type === "backup") {
        const user = await User.findOneOrFail({
            where: { id: user_id },
            select: { id: true, totp_secret: true, mfa_enabled: true },
        });
        if (type === "totp" && !user.mfa_enabled) return false;
        if (type === "backup" && !user.mfa_enabled && !(await SecurityKey.count({ where: { user_id } }))) return false;
        if (type === "totp" && user.mfa_enabled && verifyTotp(user.totp_secret, data)) return true;
        return consumeBackupCode(user_id, data);
    }
    if (type === "password") {
        if (ticket.typ !== "mfa") return false;
        const user = await User.findOneOrFail({
            where: { id: user_id },
            select: { id: true, data: true, mfa_enabled: true },
        });
        if (user.mfa_enabled || (await SecurityKey.count({ where: { user_id } }))) return false;
        return typeof data === "string" && !!user.data?.hash && bcrypt.compare(data, user.data.hash);
    }
    if (type === "sms") {
        const phone = await smsPhone(user_id);
        return !!phone && !!PhoneVerification.verify(phone, data, user_id);
    }
    if (type === "webauthn") {
        if (!ticket.ch || !ticket.origin) return false;
        const key = await findCredential(data, user_id);
        return !!key && verifyAssertion(data, ticket.ch, ticket.origin, key);
    }
    return false;
}

function recentMfaToken(req: Request) {
    const header = req.headers["x-discord-mfa-authorization"];
    if (typeof header === "string") return header;
    return req.headers.cookie
        ?.split("; ")
        .find((x) => x.startsWith("__Secure-recent_mfa="))
        ?.slice("__Secure-recent_mfa=".length);
}

export function hasRecentMfa(req: Request) {
    const decoded = readTicket(recentMfaToken(req), "mfa_verified");
    return decoded?.uid === req.user_id;
}

export async function requireMfa(req: Request, opts: { password?: unknown } = {}) {
    if (hasRecentMfa(req)) return;
    if (typeof opts.password === "string") {
        const user = await User.findOneOrFail({
            where: { id: req.user_id },
            select: { id: true, data: true, mfa_enabled: true },
        });
        const keys = await SecurityKey.count({ where: { user_id: req.user_id } });
        if (!user.mfa_enabled && !keys && user.data?.hash) {
            if (await bcrypt.compare(opts.password, user.data.hash)) return;
            throw passwordMismatch();
        }
    }
    throw new ResponseError(401, {
        message: "Two factor is required for this operation",
        code: 60003,
        mfa: await mfaChallenge(req, req.user_id),
    });
}

export function issueRecentMfa(res: Response, user_id: string) {
    const token = signTicket({ typ: "mfa_verified", uid: user_id });
    res.cookie("__Secure-recent_mfa", token, {
        maxAge: 300000,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
    });
    return token;
}

export async function loginMfaResponse(req: Request, user: User, extra: Record<string, unknown> = {}) {
    const keys = await SecurityKey.find({ where: { user_id: user.id } });
    const totp = !!(user.mfa_enabled && user.totp_secret);
    if (!totp && !keys.length) return null;
    const sms = !!(await smsPhone(user.id));
    const origin = requestOrigin(req);
    const assertion = keys.length ? assertionOptions(origin, keys) : null;
    return {
        user_id: user.id,
        token: null,
        mfa: true,
        sms,
        totp,
        backup: true,
        webauthn: assertion?.options ?? null,
        ticket: signTicket({ ...extra, typ: "login", uid: user.id, ch: assertion?.challenge, origin }),
        login_instance_id: crypto.randomUUID(),
    };
}

export async function emitUserUpdate(user_id: string) {
    const user = await User.findOneOrFail({
        where: { id: user_id },
        select: Object.fromEntries(PrivateUserProjection.map((x) => [x, true])),
    });
    await emitEvent({
        event: "USER_UPDATE",
        user_id,
        data: { ...user.toPrivateUser(), authenticator_types: await authenticatorTypes(user_id) },
    } as unknown as UserUpdateEvent);
}

export async function emitUserEvent(user_id: string, event: string, data: unknown) {
    await emitEvent({ event: event as EVENT, user_id, data } as Event);
}

export async function freshBackupCodes(user_id: string) {
    await BackupCode.update({ user: { id: user_id } }, { expired: true });
    const codes = generateMfaBackupCodes(user_id);
    await Promise.all(codes.map((x) => x.save()));
    return codes;
}

export const serializeBackupCodes = (user_id: string, codes: BackupCode[]) => codes.map((x) => ({ user_id, code: x.code, consumed: x.consumed }));

export const passwordMismatch = (field = "password") =>
    new ResponseError(400, {
        message: "Password does not match.",
        code: 50018,
        errors: {
            [field]: {
                _errors: [{ code: "PASSWORD_DOES_NOT_MATCH", message: "Password does not match." }],
            },
        },
    });

export async function requireAccountPassword(req: Request) {
    const user = await User.findOneOrFail({
        where: { id: req.user_id },
        select: { id: true, data: true, mfa_enabled: true },
    });
    const password = req.body?.password;
    if (user.data?.hash && !(typeof password === "string" && (await bcrypt.compare(password, user.data.hash)))) throw passwordMismatch();
    if (user.mfa_enabled) await requireMfa(req);
}

export async function revokeSessions(user_id: string, except?: string) {
    const sessions = await Session.find({ where: { user_id }, select: { session_id: true } });
    for (const session of sessions) {
        if (session.session_id === except) continue;
        await emitEvent({
            session_id: session.session_id,
            event: "SB_SESSION_REMOVE",
            origin: "Sessions revoked",
        } as Event);
        await Session.delete({ session_id: session.session_id });
    }
    await revokeStaleE2eeDevices(user_id);
}

export async function restartOtherSessions(req: Request) {
    const user = await User.findOneOrFail({ where: { id: req.user_id }, select: { id: true, data: true } });
    await User.update({ id: user.id }, { data: { ...user.data, valid_tokens_since: new Date() } });
    await revokeSessions(user.id, req.session?.session_id);
    return (await generateToken(user.id, false, undefined, req.session)) as string;
}

export const currentToken = (req: Request) => (req.headers.authorization ?? "").replace(/^(Bot|Bearer) /, "");
