import { isSqlite } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { adminCustomizationTarget, recordAdminCustomization } from "@spacebar/api/util/handlers/AdminUserCustomization";
import { PRIDE_BADGES } from "@spacebar/api/util/utility/prideBadges";
import { User, getDatabase } from "@spacebar/database";
import { broadcastUserUpdate, FieldErrors, Config } from "@spacebar/util";
import { PrideBadgesSchema } from "@spacebar/schemas";
const router = Router({ mergeParams: true });
const catalog = () =>
    PRIDE_BADGES.map((badge) => ({
        ...badge,
        icon_url: `${(Config.get().cdn.endpointPublic || "").replace(/\/+$/, "")}/badge-icons/${badge.icon}.png`,
    }));
router.get("/", route({ right: "MANAGE_USERS", spacebarOnly: true }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req);
    const user = await User.findOneOrFail({
        where: { id: target.id },
        select: { id: true, pride_badges: true },
    });
    res.json({ flags: user.pride_badges || [], catalog: catalog() });
});
router.patch("/", route({ right: "MANAGE_USERS", spacebarOnly: true, requestBody: "PrideBadgesSchema" }), async (req: Request, res: Response) => {
    const target = await adminCustomizationTarget(req);
    const { flags } = req.body as PrideBadgesSchema;
    if (!Array.isArray(flags) || flags.length > PRIDE_BADGES.length || flags.some((slug) => typeof slug !== "string" || !PRIDE_BADGES.some((badge) => badge.slug === slug)))
        throw FieldErrors({
            flags: { code: "BASE_TYPE_INVALID", message: "Choose flags from the pride badge catalog." },
        });
    const selected = [...new Set(flags)];
    const changed = await getDatabase()!.transaction(async (manager) => {
        const result = await manager
            .createQueryBuilder()
            .update(User)
            .set({ pride_badges: selected })
            .where("id = :id", { id: target.id })
            .andWhere(isSqlite() ? "pride_badges IS DISTINCT FROM :selected" : "pride_badges IS DISTINCT FROM :selected::text[]", { selected })
            .execute();
        if (result.affected) await recordAdminCustomization(req, target.id, "pride_badges", ["pride_badges"], manager);
        return !!result.affected;
    });
    if (changed) await broadcastUserUpdate(target.id, selected);
    res.json({ flags: selected, catalog: catalog() });
});
export default router;
