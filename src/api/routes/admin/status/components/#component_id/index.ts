import { sqlArrayRemove } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { StatusComponent, StatusIncident } from "@spacebar/database";
import { AdminStatusComponentUpdateSchema } from "@spacebar/schemas";
import { serializeComponent } from "@spacebar/api/util";

const router = Router({ mergeParams: true });

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminStatusComponentUpdateSchema",
        description: "Edit a status page component",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminStatusComponentUpdateSchema;
        const component = await StatusComponent.findOneOrFail({
            where: { id: req.params.component_id as string },
        });
        if (body.name !== undefined) component.name = body.name.trim();
        if (body.description !== undefined) component.description = body.description?.trim() || null;
        if (body.status !== undefined) component.status = body.status;
        if (body.position !== undefined) component.position = body.position;
        component.updated_at = new Date();
        await component.save();
        res.json(serializeComponent(component));
    },
);

router.delete(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Remove a status page component",
        responses: { 204: {} },
    }),
    async (req: Request, res: Response) => {
        const id = req.params.component_id as string;
        await StatusComponent.findOneOrFail({ where: { id }, select: { id: true } });
        await StatusIncident.query(`UPDATE "status_incidents" SET "component_ids" = ${sqlArrayRemove('"component_ids"', "CAST($1 AS bigint)")}`, [id]);
        await StatusComponent.delete({ id });
        res.sendStatus(204);
    },
);

export default router;
