import { sqlLike } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { Brackets } from "typeorm";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Rights } from "@spacebar/util";
import { User } from "@spacebar/database";
import { AdminUserTag, UserFlags } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

export const ADMIN_USER_COLUMNS = [
    "id",
    "username",
    "discriminator",
    "global_name",
    "avatar",
    "email",
    "created_at",
    "disabled",
    "deleted",
    "verified",
    "premium_type",
    "rights",
    "bot",
    "flags",
    "public_flags",
    "badge_ids",
    "hide_premium_badge",
    "account_standing",
] as const;

// entities carry class-level defaults for every column, so only ever send the columns we selected
export const pickAdminUser = (user: User) => ({
    ...Object.fromEntries(ADMIN_USER_COLUMNS.map((c) => [c, user[c] ?? null])),
    tag: userTag(user),
});

export const assertCanManage = (req: Request, target: Pick<User, "id" | "rights">) => {
    if (target.id !== req.user_id && new Rights(target.rights).has("OPERATOR") && !req.rights.has("OPERATOR"))
        throw new HTTPError("Only operators can manage other operators", 403);
};

const TAG_FLAGS = {
    verified: Number(UserFlags.FLAGS.VERIFIED_BOT),
    ai: Number(UserFlags.FLAGS.AI_ACCOUNT),
    official: Number(UserFlags.FLAGS.OFFICIAL_TAG),
    system: Number(UserFlags.FLAGS.SYSTEM_TAG),
};

export const userTag = (user: Pick<User, "public_flags">): AdminUserTag => {
    const flags = Number(user.public_flags ?? 0);
    if (flags & TAG_FLAGS.official) return "official";
    if (flags & TAG_FLAGS.system) return "system";
    const verified = (flags & TAG_FLAGS.verified) !== 0;
    if (flags & TAG_FLAGS.ai) return verified ? "verified_ai" : "ai";
    return verified ? "verified_bot" : "none";
};

// public_flags is what other clients see; flags is what the user's own client sees, so both carry the tag
export const applyUserTag = (user: User, tag: AdminUserTag) => {
    const wanted =
        (tag === "verified_bot" || tag === "verified_ai" ? TAG_FLAGS.verified : 0) |
        (tag === "ai" || tag === "verified_ai" ? TAG_FLAGS.ai : 0) |
        (tag === "official" ? TAG_FLAGS.official : 0) |
        (tag === "system" ? TAG_FLAGS.system : 0);
    const mask = TAG_FLAGS.verified | TAG_FLAGS.ai | TAG_FLAGS.official | TAG_FLAGS.system;
    user.public_flags = (Number(user.public_flags ?? 0) & ~mask) | wanted;
    user.flags = Number((BigInt(user.flags ?? 0) & ~BigInt(mask)) | BigInt(wanted));
};

const scalarQuery = (value: unknown, name: string, fallback: string): string => {
    if (value === undefined) return fallback;
    if (typeof value !== "string") throw new HTTPError(`${name} must be supplied once as a string`, 400);
    return value;
};

const paginationQuery = (value: unknown, name: string, fallback: number): number => {
    const text = scalarQuery(value, name, String(fallback));
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new HTTPError(`${name} must be a non-negative safe integer`, 400);
    return Number(text);
};

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Search users on this instance. `q` matches an exact id, or part of a username, display name or email.",
        query: {
            q: { type: "string", required: false },
            filter: {
                type: "string",
                required: false,
                description: "all | disabled | bots | verified | unverified",
            },
            limit: { type: "number", required: false },
            offset: { type: "number", required: false },
        },
    }),
    async (req: Request, res: Response) => {
        const q = scalarQuery(req.query.q, "q", "").trim();
        if (q.length > 256) throw new HTTPError("q must be no longer than 256 characters", 400);
        const filter = scalarQuery(req.query.filter, "filter", "all");
        if (!["all", "disabled", "bots", "verified", "unverified"].includes(filter)) throw new HTTPError("filter must be all, disabled, bots, verified or unverified", 400);
        const limit = Math.min(Math.max(paginationQuery(req.query.limit, "limit", 50), 1), 100);
        const offset = paginationQuery(req.query.offset, "offset", 0);
        const searchPattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;

        const query = User.createQueryBuilder("user")
            .select(ADMIN_USER_COLUMNS.map((c) => `user.${c}`))
            .orderBy("user.created_at", "DESC")
            .addOrderBy("user.id", "DESC")
            .take(limit)
            .skip(offset);

        if (/^\d{15,20}$/.test(q)) {
            if (BigInt(q) > 9223372036854775807n) throw new HTTPError("The user id is outside the supported range", 400);
            query.where("user.id = :id", { id: q });
        } else if (q)
            query.where(
                new Brackets((qb) =>
                    qb
                        .where(`${sqlLike("user.username", ":q")}`, { q: searchPattern })
                        .orWhere(`${sqlLike("user.global_name", ":q")}`, { q: searchPattern })
                        .orWhere(`${sqlLike("user.email", ":q")}`, { q: searchPattern }),
                ),
            );

        switch (filter) {
            case "disabled":
                query.andWhere("user.disabled = true");
                break;
            case "bots":
                query.andWhere("user.bot = true");
                break;
            case "verified":
                query.andWhere("user.verified = true");
                break;
            case "unverified":
                query.andWhere("user.verified = false");
                break;
            default: // "all"
                break;
        }

        const [users, total] = await query.getManyAndCount();
        res.json({ total, users: users.map(pickAdminUser) });
    },
);

export default router;
