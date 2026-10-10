import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { Router, Response, Request } from "express";
import { Raw } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { AvatarDecoration, Member } from "@spacebar/database";
import { PublicAvatarDecorationListResponse } from "@spacebar/schemas/api/spacebar/AvatarDecorations";
import { arrayDistinctBy } from "@spacebar/extensions";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        description: "Get available avatar decorations",
        responses: {
            200: {
                body: "PublicAvatarDecorationListResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const memberships = await Member.find({
            select: { guild_id: true, roles: { id: true } },
            relations: { roles: true },
            where: { id: req.user_id },
        });

        const decos = (
            await AvatarDecoration.find({
                where: [
                    { approved: true, public: true },
                    { approved: true, uploader_id: req.user_id },
                    {
                        approved: true,
                        allowed_user_ids: Raw((columnAlias) => sqlArrayIncludes("CAST(:req_uid AS bigint)", columnAlias), {
                            req_uid: req.user_id,
                        }),
                    },
                    {
                        approved: true,
                        allowed_guild_ids: Raw((columnAlias) => `${columnAlias} && :guild_ids`, {
                            guild_ids: memberships.map((x) => x.guild_id),
                        }),
                    },
                    {
                        approved: true,
                        allowed_role_ids: Raw((columnAlias) => `${columnAlias} && :role_ids`, {
                            role_ids: memberships.flatMap((x) => x.roles.map((r) => r.id)),
                        }),
                    },
                ],
                relations: {
                    uploader: true,
                },
                order: {
                    id: "DESC",
                },
            })
        ).map((x) => x.toPublicAvatarDecoration({ available: true }));

        res.json(arrayDistinctBy(decos, (d) => d.id) satisfies PublicAvatarDecorationListResponse);
    },
);

export default router;
