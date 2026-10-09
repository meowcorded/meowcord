import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Email } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            204: {},
            400: {
                body: "APIErrorResponse",
            },
            500: {
                body: "APIErrorResponse",
            },
        },
        allowUnverified: true,
    }),
    async (req: Request, res: Response) => {
        const user = await User.findOneOrFail({
            where: { id: req.user_id },
            select: { id: true, username: true, discriminator: true, email: true, verified: true },
        });

        if (!user.email) {
            // TODO: whats the proper error response for this?
            throw new HTTPError("User does not have an email address", 400);
        }

        if (user.verified) {
            throw new HTTPError("Email is already verified", 400);
        }

        await Email.sendVerifyEmail(user, user.email)
            .then(() => res.sendStatus(204))
            .catch((e) => {
                console.error(`Failed to send verification email to ${user.tag}: ${e}`);
                throw new HTTPError("Failed to send verification email", 500);
            });
    },
);

export default router;
