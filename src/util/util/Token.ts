import crypto, { KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import fs from "node:fs/promises";
import jwt from "jsonwebtoken";
import { HTTPError } from "lambert-server/HTTPError";
import { MoreThan } from "typeorm";
import { AccountStandingState } from "@spacebar/schemas";
import { InstanceBan, OAuth2Token, Session, User } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import { Config } from "./Config";
import { OrmUtils } from "@spacebar/util";
import { clearInterval, setInterval } from "node:timers";
import { ProcessLifecycle } from "@spacebar/util/util/ProcessLifecycle";

/// Change history:
/// 1 - Initial version with HS256
/// 2 - Switched to ES512
/// 3 - Add version, device id to token payload
export const CurrentTokenFormatVersion: number = 3;

export type UserTokenData = {
    user: User;
    session?: Session;
    tokenVersion: number;
    decoded: {
        id: string;
        iat: number;
        // token format version
        ver?: number;
        // device id
        did?: string;
        // OAuth scopes
        scopes?: string[];
        exp?: number;
        nbf?: number;
    };
    oauth2?: { token_id: string; application_id: string; scopes: string[]; expires_at: Date };
};

function logAuth(text: string) {
    if (process.env.LOG_AUTH !== "true") return;
    console.log(`[AUTH] ${text}`);
}

function rejectAndLog(rejectFunction: (reason?: unknown) => void, httpCode: number | undefined, reason: string) {
    console.error(reason);
    rejectFunction(new HTTPError(reason, httpCode ?? 400));
}

const VERIFIED_TOKEN_CACHE_SIZE = 10000;
const verifiedTokens = new Map<string, { key: string | Buffer | KeyObject; decoded: UserTokenData["decoded"] }>();

export const checkToken = (
    token: string,
    opts?: {
        select?: string[]; // TODO: clean up
        relations?: string[]; // TODO: clean up
        ipAddress?: string;
        fingerprint?: string;
    },
): Promise<UserTokenData> =>
    new Promise((resolve, reject) => {
        token = token.replace("Bot ", ""); // there is no bot distinction in sb
        token = token.replace("Bearer ", ""); // allow bearer tokens

        let legacyVersion: number | undefined;

        const validateUser = async (err: jwt.VerifyErrors | null, out: jwt.JwtPayload | string | undefined) => {
            const decoded = out as UserTokenData["decoded"] & { typ?: unknown };
            if (!err && (typeof decoded?.id !== "string" || decoded.typ !== undefined)) err = new jwt.JsonWebTokenError("not a user token");
            if (err || !decoded) {
                logAuth("validateUser rejected: " + err);
                return rejectAndLog(reject, 401, `Invalid Token: ${err}`);
            }

            // eslint-disable-next-line prefer-const
            const [user, session, banned] = await Promise.all([
                User.findOne({
                    where: { id: decoded.id },
                    select: OrmUtils.keysToObject([...(opts?.select || []), "id", "bot", "disabled", "deleted", "account_standing", "rights", "data", "flags", "verified"]), // TODO: clean up
                    relations: !opts?.relations ? undefined : OrmUtils.keysToObject(opts.relations), // TODO: clean up
                }),
                decoded.did ? Session.findOne({ where: { session_id: decoded.did, user_id: decoded.id } }) : undefined,
                InstanceBan.hasInstanceBans({
                    userId: decoded.id,
                    ipAddress: opts?.ipAddress,
                    fingerprint: opts?.fingerprint,
                }),
            ]);

            if (!user) {
                logAuth("validateUser rejected: User not found");
                return rejectAndLog(reject, 401, "User not found");
            }

            if (decoded.did && !session) {
                logAuth("validateUser rejected: Session revoked");
                return rejectAndLog(reject, 401, "Invalid Token");
            }

            // we need to round it to seconds as it saved as seconds in jwt iat and valid_tokens_since is stored in milliseconds
            if (decoded.iat < Math.floor(new Date(user.data.valid_tokens_since).getTime() / 1000)) {
                logAuth("validateUser rejected: Token not yet valid");
                return rejectAndLog(reject, 401, "Invalid Token");
            }

            if (user.disabled || user.account_standing === AccountStandingState.SUSPENDED) {
                logAuth("validateUser rejected: User disabled");
                return rejectAndLog(reject, 401, "User disabled");
            }

            if (user.deleted) {
                logAuth("validateUser rejected: User deleted");
                return rejectAndLog(reject, 401, "User not found");
            }

            const banReasons = banned
                ? await InstanceBan.findInstanceBans({
                      userId: user.id,
                      ipAddress: opts?.ipAddress,
                      fingerprint: opts?.fingerprint,
                      propagateBan: true,
                  })
                : [];
            if (banReasons.length > 0) {
                logAuth("validateUser rejected: User banned for reasons: " + banReasons.join(", "));
                return rejectAndLog(reject, 418, "Invalid Token");
            }

            const now = new Date();
            if (session && (session.last_seen?.getTime() ?? 0) <= now.getTime() - 15_000) {
                const activity = {
                    last_seen: now,
                    ...(opts?.ipAddress ? { last_seen_ip: opts.ipAddress } : {}),
                };
                await Session.createQueryBuilder()
                    .update(Session)
                    .set(activity)
                    .where("session_id = :sessionId AND user_id = :userId", {
                        sessionId: session.session_id,
                        userId: user.id,
                    })
                    .andWhere("(last_seen IS NULL OR last_seen <= :cutoff)", {
                        cutoff: new Date(now.getTime() - 15_000),
                    })
                    .execute();
                Object.assign(session, activity);
            }

            const result: UserTokenData = {
                decoded,
                session: session ?? undefined,
                user,
                // v1 can be told apart, v2 cant outside of missing device id and version
                tokenVersion: decoded.ver ?? legacyVersion ?? 2,
            };

            if (process.env.LOG_TOKEN_VERSION) console.log("User", user.id, "logged in with token version", result.tokenVersion);

            logAuth("validateUser success for user " + user.id);
            return resolve(result);
        };

        const dec = (() => {
            try {
                return jwt.decode(token, { complete: true });
            } catch {
                return null;
            }
        })();
        if (!dec) return void rejectAndLog(reject, 401, "Failed to decode token");
        logAuth("Decoded token header using " + dec.header.alg);

        let key: string | Buffer | KeyObject;
        if (dec.header.alg == "HS256" && dec.header.kid === "c") key = compactTokenSecret();
        else if (dec.header.alg == "HS256" && Config.get().security.jwtSecret !== null) {
            legacyVersion = 1;
            key = Config.get().security.jwtSecret!;
        } else if (dec.header.alg == "ES512") key = JwtKeypairManager.keypair.publicKey;
        else return void rejectAndLog(reject, 401, "Unsupported token algorithm: " + dec.header.alg);

        const verified = verifiedTokens.get(token);
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (
            verified?.key === key &&
            (verified.decoded.exp === undefined || nowSeconds < verified.decoded.exp) &&
            (verified.decoded.nbf === undefined || nowSeconds >= verified.decoded.nbf)
        )
            return void validateUser(null, verified.decoded).catch(reject);
        verifiedTokens.delete(token);
        jwt.verify(token, key, { algorithms: [dec.header.alg] }, (err, out) => {
            if (!err && out && typeof out === "object") {
                if (verifiedTokens.size >= VERIFIED_TOKEN_CACHE_SIZE) verifiedTokens.delete(verifiedTokens.keys().next().value!);
                verifiedTokens.set(token, { key, decoded: out as UserTokenData["decoded"] });
            }
            void validateUser(err, out).catch(reject);
        });
    });

export const hashOAuth2Token = (token: string) => crypto.createHash("sha256").update(token).digest("base64url");

export const isOAuth2AccessToken = (authorization: string) => /^Bearer [A-Za-z0-9_-]{20,}$/.test(authorization);

export async function checkOAuth2Token(authorization: string, opts?: { ipAddress?: string; fingerprint?: string }): Promise<UserTokenData> {
    const token = await OAuth2Token.findOne({
        where: {
            access_token_hash: hashOAuth2Token(authorization.slice("Bearer ".length)),
            expires_at: MoreThan(new Date()),
        },
        relations: { user: true },
    });
    const user = token?.user;
    if (!token || !user || user.disabled || user.deleted || user.account_standing === AccountStandingState.SUSPENDED) throw new HTTPError("Invalid Token", 401);
    if (
        await InstanceBan.hasInstanceBans({
            userId: user.id,
            ipAddress: opts?.ipAddress,
            fingerprint: opts?.fingerprint,
        })
    ) {
        const banReasons = await InstanceBan.findInstanceBans({
            userId: user.id,
            ipAddress: opts?.ipAddress,
            fingerprint: opts?.fingerprint,
            propagateBan: true,
        });
        if (banReasons.length > 0) throw new HTTPError("Invalid Token", 418);
    }
    return {
        user,
        tokenVersion: CurrentTokenFormatVersion,
        decoded: {
            id: user.id,
            iat: Math.floor(token.created_at.getTime() / 1000),
            scopes: token.scopes,
        },
        oauth2: {
            token_id: token.id,
            application_id: token.application_id,
            scopes: token.scopes,
            expires_at: token.expires_at,
        },
    };
}

let compactSecretKeypair: KeyObject | undefined;
let compactSecret: Buffer;
const compactTokenSecret = () => {
    const privateKey = JwtKeypairManager.keypair.privateKey;
    if (compactSecretKeypair !== privateKey) {
        compactSecret = crypto
            .createHash("sha256")
            .update("compact-token")
            .update(privateKey.export({ format: "pem", type: "sec1" }))
            .digest();
        compactSecretKeypair = privateKey;
    }
    return compactSecret;
};

async function assertNotSuspended(id: string) {
    const user = await User.findOneOrFail({
        where: { id },
        select: { id: true, account_standing: true },
    });
    if (user.account_standing === AccountStandingState.SUSPENDED) throw new HTTPError("Account suspended", 403);
}

export async function generateCompactToken(id: string): Promise<string> {
    await assertNotSuspended(id);
    const session = Session.create({
        session_id: Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10),
        user_id: id,
        is_admin_session: false,
        client_status: {},
        status: "offline",
        client_info: {},
        last_seen: new Date(),
    });
    await session.save();
    return jwt.sign(
        {
            id,
            iat: Math.floor(Date.now() / 1000),
            ver: CurrentTokenFormatVersion,
            did: session.session_id,
        },
        compactTokenSecret(),
        {
            algorithm: "HS256",
            header: { alg: "HS256", kid: "c", typ: undefined },
        },
    );
}

export async function generateToken(id: string, isAdminSession: boolean = false, scopes: string[] | undefined = undefined, existingSession?: Session): Promise<string | undefined> {
    await assertNotSuspended(id);
    const iat = Math.floor(Date.now() / 1000);
    const keyPair = JwtKeypairManager.keypair;

    const session =
        existingSession ??
        (await (async () => {
            let created;
            do {
                created = Session.create({
                    session_id: Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10),
                    user_id: id,
                    is_admin_session: isAdminSession,
                    client_status: {},
                    status: "offline",
                    client_info: {},
                    last_seen: new Date(),
                });
            } while (await Session.findOne({ where: { session_id: created.session_id } }));
            return created.save();
        })());

    return new Promise((res, rej) => {
        const payload = {
            id,
            iat,
            kid: keyPair.fingerprint,
            ver: CurrentTokenFormatVersion,
            did: session.session_id,
            scopes,
        } as UserTokenData["decoded"];
        jwt.sign(
            payload,
            keyPair.privateKey,
            {
                algorithm: "ES512",
            },
            (err, token) => {
                if (err) return rej(err);
                return res(token);
            },
        );
    });
}

export class JwtKeypairManager {
    private static initialization: Promise<void> | undefined;
    private static checking?: Promise<void>;
    private static closing?: Promise<void>;
    private static stopping = false;
    private static filesystemCheckInterval?: ReturnType<typeof setInterval>;
    static #keypair?: JwtKeypair;

    public static get keypair() {
        if (!this.#keypair) throw new Error("JwtKeypairManager#keypair.get called before being initialized.");
        return this.#keypair;
    }

    public static init() {
        if (this.#keypair) return Promise.resolve();
        if (this.initialization) return this.initialization;
        this.initialization = this.initialize().finally(() => {
            this.initialization = undefined;
        });
        return this.initialization;
    }

    private static async initialize() {
        try {
            let privateKey: crypto.KeyObject;
            let publicKey: crypto.KeyObject;

            if (existsSync("jwt.key") && existsSync("jwt.key.pub")) {
                const [loadedPrivateKey, loadedPublicKey] = await Promise.all([fs.readFile("jwt.key"), fs.readFile("jwt.key.pub")]);

                privateKey = crypto.createPrivateKey(loadedPrivateKey);
                publicKey = crypto.createPublicKey(loadedPublicKey);
            } else {
                console.log("[JWT] Generating new keypair:", path.resolve("jwt.key"), "- PWD:", process.cwd());
                const res = crypto.generateKeyPairSync("ec", {
                    namedCurve: "secp521r1",
                });
                privateKey = res.privateKey;
                publicKey = res.publicKey;

                await this.writeKeypair({ privateKey, publicKey });
            }

            const fingerprint = crypto
                .createHash("sha256")
                .update(publicKey.export({ format: "pem", type: "spki" }))
                .digest("hex");

            this.#keypair = new JwtKeypair(privateKey, publicKey, fingerprint);

            ProcessLifecycle.eventEmitter.once("shutdownRequested", () => this.stopAdmission());
            ProcessLifecycle.eventEmitter.once("stopping", () => this.close());
            if (!ProcessLifecycle.shutdownRequested && !this.stopping) this.filesystemCheckInterval = setInterval(() => this.runDeletionCheck(), 60_000).unref();
        } catch (e) {
            console.error(`[JwtKeypairManager] Initialization failed:`, e);
            throw e;
        }
    }

    private static stopAdmission() {
        this.stopping = true;
        if (this.filesystemCheckInterval) {
            clearInterval(this.filesystemCheckInterval);
            this.filesystemCheckInterval = undefined;
        }
    }

    private static close(): Promise<void> {
        if (this.closing) return this.closing;
        this.stopAdmission();
        this.closing = this.checking ?? this.startCheck();
        return this.closing;
    }

    private static runDeletionCheck(): Promise<void> {
        if (this.stopping || ProcessLifecycle.shutdownRequested) return Promise.resolve();
        return this.checking ?? this.startCheck();
    }

    private static startCheck(): Promise<void> {
        const work = this.restoreMissingKeys().finally(() => {
            this.checking = undefined;
        });
        this.checking = work;
        return work;
    }

    private static async writeKeypair(keys: { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject }) {
        const writes = await Promise.allSettled([
            fs.writeFile("jwt.key", keys.privateKey.export({ format: "pem", type: "sec1" })),
            fs.writeFile("jwt.key.pub", keys.publicKey.export({ format: "pem", type: "spki" })),
        ]);
        const failure = writes.find((write) => write.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }

    private static async restoreMissingKeys() {
        try {
            if (!existsSync("jwt.key") || !existsSync("jwt.key.pub")) {
                console.log("[JWT] Keypair files disappeared... Saving them again.");
                await this.writeKeypair(this.keypair);
            }
        } catch (e) {
            console.error("[JwtKeypairManager] Failed to check if keypair was accidentally deleted:", e);
        }
    }
}

class JwtKeypair {
    public readonly privateKey: KeyObject;
    public readonly publicKey: KeyObject;
    public readonly fingerprint: string;

    constructor(privateKey: KeyObject, publicKey: KeyObject, fingerprint: string) {
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.fingerprint = fingerprint;
    }
}
