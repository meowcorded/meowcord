import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Badge, User } from "@spacebar/database";
import { handleFile, Snowflake } from "@spacebar/util";
import { AdminBadgeCreateSchema } from "@spacebar/schemas";

const router = Router({ mergeParams: true });

export const serializeBadge = (badge: Badge, holders?: number) => ({
    id: badge.id,
    description: badge.description,
    icon: badge.icon,
    link: badge.link ?? null,
    ...(holders !== undefined ? { holders } : {}),
});

// either an uploaded image or an existing icon hash (unknown hashes are proxied from discord's CDN)
export const resolveBadgeIcon = async (body: { icon?: string; icon_data?: string }) => {
    if (body.icon_data) {
        const id = await handleFile("/badge-icons", body.icon_data);
        if (!id) throw new HTTPError("icon_data must be a data: URI image", 400);
        return id;
    }
    const icon = body.icon?.trim().replace(/\.png$/, "");
    if (icon !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(icon)) throw new HTTPError("icon must be an icon hash", 400);
    return icon;
};

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "List instance profile badges with how many users have each",
    }),
    async (req: Request, res: Response) => {
        const badges = await Badge.find({ order: { description: "ASC" } });
        const counts: { id: string; holders: string }[] = await User.query(
            `SELECT b.id, COUNT(u.id) AS holders FROM badges b LEFT JOIN users u ON ${sqlArrayIncludes("CAST(b.id AS bigint)", "u.badge_ids")} GROUP BY b.id`,
        );
        res.json(badges.map((b) => serializeBadge(b, Number(counts.find((c) => c.id === b.id)?.holders ?? 0))));
    },
);

router.post(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminBadgeCreateSchema",
        description: "Create a profile badge",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminBadgeCreateSchema;
        const icon = await resolveBadgeIcon(body);
        if (!icon) throw new HTTPError("A badge needs an icon (icon or icon_data)", 400);

        const badge = await Badge.create({
            id: Snowflake.generate(),
            description: body.description.trim(),
            icon,
            link: body.link?.trim() || undefined,
        }).save();
        res.status(201).json(serializeBadge(badge, 0));
    },
);

export default router;
