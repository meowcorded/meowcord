/* SPDX-License-Identifier: AGPL-3.0-only */
import { Router, Response, Request } from "express";
import { route } from "@spacebar/api/middlewares";
import { EmailImage, emailImagePng, emailImageSource, sendBrandImage } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const kind = /^(icon|wordmark)\.png$/.exec(req.params.file as string)?.[1] as EmailImage | undefined;
        const source = kind && emailImageSource(kind);
        if (!kind || !source) return res.sendStatus(404);
        const png = await emailImagePng(kind);
        if (!png) return sendBrandImage(res, source, "no-cache");
        res.set("Cache-Control", "public, max-age=21600").type("png").send(png);
    },
);

export default router;
