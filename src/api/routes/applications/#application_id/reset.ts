import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { hashClientSecret, randomOAuth2Token, requireMfaIfEnabled } from "@spacebar/api/util";
import { Application } from "@spacebar/database";
import { DiscordApiErrors } from "@spacebar/util";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        description: "Reset the application's OAuth2 client secret",
        responses: {
            200: {},
            400: { body: "APIErrorResponse" },
            403: { body: "APIErrorResponse" },
        },
    }),
    async (req: Request, res: Response) => {
        const app = await Application.findOneOrFail({
            where: { id: req.params.application_id as string },
            select: { id: true, owner_id: true },
        });
        if (app.owner_id !== req.user_id) throw DiscordApiErrors.ACTION_NOT_AUTHORIZED_ON_APPLICATION;
        await requireMfaIfEnabled(req);
        const secret = randomOAuth2Token();
        await Application.update({ id: app.id }, { client_secret_hash: hashClientSecret(secret) });
        res.json({ secret });
    },
);

export default router;
