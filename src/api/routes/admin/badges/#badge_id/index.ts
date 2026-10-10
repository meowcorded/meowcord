import { sqlArrayIncludes, sqlArrayRemove } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Badge, User } from "@spacebar/database";
import { AdminBadgeUpdateSchema } from "@spacebar/schemas";
import { resolveBadgeIcon, serializeBadge } from "../index";

const router = Router({ mergeParams: true });

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminBadgeUpdateSchema",
        description: "Edit a profile badge",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminBadgeUpdateSchema;
        const badge = await Badge.findOneOrFail({ where: { id: req.params.badge_id as string } });

        const icon = await resolveBadgeIcon(body);
        if (icon) badge.icon = icon;
        if (body.description !== undefined) badge.description = body.description.trim();
        if (body.link !== undefined) Object.assign(badge, { link: body.link?.trim() || null });
        await badge.save();

        res.json(serializeBadge(badge));
    },
);

router.delete(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Delete a profile badge and take it off everyone who has it",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const id = req.params.badge_id as string;
        await Badge.findOneOrFail({ where: { id }, select: { id: true } });
        await User.query(`UPDATE "users" SET "badge_ids" = ${sqlArrayRemove('"badge_ids"', "CAST($1 AS bigint)")} WHERE ${sqlArrayIncludes("CAST($1 AS bigint)", '"badge_ids"')}`, [
            id,
        ]);
        await Badge.delete({ id });
        res.sendStatus(204);
    },
);

export default router;
