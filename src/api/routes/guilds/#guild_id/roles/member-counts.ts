import { Request, Response, Router } from "express";
import { Role, Member } from "@spacebar/database";
import { route } from "@spacebar/api/middlewares";

const router: Router = Router({ mergeParams: true });

router.get("/", route({}), async (req: Request, res: Response) => {
    const { guild_id } = req.params as { [key: string]: string };
    await Member.IsInGuildOrFail(req.user_id, guild_id);

    const [role_ids, rows] = await Promise.all([
        Role.find({ where: { guild_id }, select: { id: true } }),
        Member.query(
            `SELECT mr.role_id, CAST(COUNT(DISTINCT m.id) AS integer) AS count FROM member_roles mr JOIN members m ON m."index" = mr."index" WHERE m.guild_id = $1 GROUP BY mr.role_id`,
            [guild_id],
        ) as Promise<{ role_id: string; count: number }[]>,
    ]);
    const byRole = new Map(rows.map((x) => [`${x.role_id}`, x.count]));
    const counts: { [id: string]: number } = Object.fromEntries(role_ids.map(({ id }) => [id, byRole.get(id) ?? 0]));

    return res.json(counts);
});

export default router;
