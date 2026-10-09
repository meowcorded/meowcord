import fs from "node:fs/promises";
import path from "node:path";
import { Router, Response, Request } from "express";
import { route } from "@spacebar/api/middlewares";
import { PUBLIC_ASSETS_FOLDER, brandPage } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        res.set("Cache-Control", "no-cache")
            .type("html")
            .send(brandPage(await fs.readFile(path.join(PUBLIC_ASSETS_FOLDER, "verify.html"), "utf8")));
    },
);

export default router;
