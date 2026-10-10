import { sqlArrayIncludes, sqlLike } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { Brackets } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { Guild } from "@spacebar/database";
import { Config } from "@spacebar/util";
import { discoveryPage, hiddenDiscoveryGuildIds, toDiscoveryList } from "@spacebar/api/util/handlers/Discovery";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "DiscoverableGuildsSearchResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const term = String(req.query.query ?? "")
            .trim()
            .slice(0, 100);
        const { offset, limit } = discoveryPage(req.query, 24);
        const categoryId = req.query.category_id ? Number(req.query.category_id) : Number.NaN;
        const hidden = await hiddenDiscoveryGuildIds(req.user_id);

        const base = () => {
            const qb = Guild.createQueryBuilder("guild").where("guild.discovery_excluded = false");
            if (!Config.get().guild.discovery.showAllGuilds) qb.andWhere(`${sqlArrayIncludes(":feature", "guild.features")}`, { feature: "DISCOVERABLE" });
            if (hidden.length) qb.andWhere("guild.id NOT IN (:...hidden)", { hidden });
            if (!term) return qb;
            return qb.andWhere(
                new Brackets((b) =>
                    b
                        .where(`${sqlLike("guild.name", ":pattern")}`)
                        .orWhere(`${sqlLike("guild.description", ":pattern")}`)
                        .orWhere(`${sqlLike("guild.vanity_url_code", ":pattern")}`),
                ),
                { pattern: `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` },
            );
        };

        const filtered = base();
        if (!Number.isNaN(categoryId)) filtered.andWhere("guild.primary_category_id = :categoryId", { categoryId });
        const [guilds, total] = await filtered
            .orderBy("guild.discovery_weight", "DESC")
            .addOrderBy("guild.member_count", "DESC")
            .addOrderBy("guild.id", "ASC")
            .skip(offset)
            .take(limit)
            .getManyAndCount();

        const categories =
            req.query.with_counts === "true"
                ? (
                      await base()
                          .select("guild.primary_category_id", "id")
                          .addSelect(`CAST(COUNT(*) AS integer)`, "count")
                          .andWhere("guild.primary_category_id IS NOT NULL")
                          .groupBy("guild.primary_category_id")
                          .orderBy("count", "DESC")
                          .getRawMany<{ id: number; count: number }>()
                  ).map(({ id, count }) => ({ id: Number(id), count }))
                : undefined;

        res.send({
            guilds: await toDiscoveryList(guilds),
            total_count: total,
            offset,
            limit,
            categories,
        });
    },
);

export default router;
