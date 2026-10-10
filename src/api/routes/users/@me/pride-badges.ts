import { isSqlite } from "@spacebar/database/Sql";
import { route } from "@spacebar/api/middlewares";
import { PRIDE_BADGE_CATALOG, PRIDE_BADGES } from "@spacebar/api/util/utility/prideBadges";
import { User } from "@spacebar/database";
import { PrideBadgesSchema } from "@spacebar/schemas";
import { broadcastUserUpdate, FieldErrors } from "@spacebar/util";
import { Request, Response, Router } from "express";

const router: Router = Router({ mergeParams: true });

router.get("/", route({ responses: { 200: {} } }), async (req: Request, res: Response) => {
    const user = await User.findOneOrFail({
        where: { id: req.user_id },
        select: { id: true, pride_badges: true },
    });
    res.json({ flags: user.pride_badges ?? [], catalog: PRIDE_BADGE_CATALOG });
});

router.patch(
    "/",
    route({
        requestBody: "PrideBadgesSchema",
        responses: { 200: {}, 400: { body: "APIErrorResponse" } },
    }),
    async (req: Request, res: Response) => {
        const { flags } = req.body as PrideBadgesSchema;
        if (!Array.isArray(flags) || flags.length > PRIDE_BADGES.length || flags.some((slug) => typeof slug !== "string" || !PRIDE_BADGES.some((badge) => badge.slug === slug)))
            throw FieldErrors({
                flags: { code: "BASE_TYPE_INVALID", message: "Choose flags from the pride badge catalog." },
            });
        const selected = [...new Set(flags)];
        const result = await User.createQueryBuilder()
            .update(User)
            .set({ pride_badges: selected })
            .where("id = :user_id", { user_id: req.user_id })
            .andWhere(isSqlite() ? "pride_badges IS DISTINCT FROM :selected" : "pride_badges IS DISTINCT FROM :selected::text[]", { selected })
            .execute();
        if (result.affected) await broadcastUserUpdate(req.user_id, selected);
        res.json({ flags: selected, catalog: PRIDE_BADGE_CATALOG });
    },
);

export default router;
