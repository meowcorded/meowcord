import { Router, Response, Request } from "express";
import { route } from "@spacebar/api/middlewares";
import { homePage } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.get(
    "/",
    route({
        spacebarOnly: true,
        authentication: "never",
    }),
    (req: Request, res: Response) => {
        res.set("Cache-Control", "no-cache");
        return res.type("html").send(homePage());
    },
);

export default router;
