import { Request, Response, Router } from "express";
import { route, parsePayloadJson } from "@spacebar/api/middlewares";
import { InteractionCallbacksSchema } from "@spacebar/schemas";
import { ApiError, DiscordApiErrors, findInteraction } from "@spacebar/util";
import { boundedMessageUpload } from "@spacebar/api/util/utility/boundedUpload";
import { tokenEquals } from "@spacebar/api/util/utility/tokenEquals";
import { processInteractionCallback } from "@spacebar/api/util/handlers/Interaction";

const router = Router({ mergeParams: true });

const upload = boundedMessageUpload();

const pendingFor = async (req: Request) => {
    const interaction = await findInteraction(req.params.interaction_id as string);
    if (!interaction || !tokenEquals(interaction.token, req.params.interaction_token)) throw DiscordApiErrors.UNKNOWN_INTERACTION;
    if (interaction.acknowledged) throw new ApiError("Interaction has already been acknowledged.", 40060, 400);
    return interaction;
};

router.post(
    "/",
    async (req, _res, next) => {
        await pendingFor(req);
        next();
    },
    upload,
    parsePayloadJson,
    route({
        stripNulls: true,
        requestBody: "InteractionCallbacksSchema",
        authentication: "never",
        query: {
            with_response: {
                type: "boolean",
                required: false,
                description: "Whether to return the interaction callback response",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const interaction = await pendingFor(req);
        const response = await processInteractionCallback(interaction, req.body as InteractionCallbacksSchema, (req.files as Express.Multer.File[]) ?? []);
        if (req.query.with_response !== "true") return res.sendStatus(204);
        return res.json(response);
    },
);

export default router;
