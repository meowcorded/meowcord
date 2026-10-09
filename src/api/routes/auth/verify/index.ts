import { Request, Response, Router } from "express";
import { emitUserUpdate, readTicket, checkCaptcha } from "@spacebar/api/util";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Config, emitRequiredAction, FieldErrors, generateToken } from "@spacebar/util";

const router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            200: {
                body: "TokenResponse",
            },
            400: {
                body: "APIErrorOrCaptchaResponse",
            },
        },
        authentication: "optional",
    }),
    async (req: Request, res: Response) => {
        const { captcha_key, token } = req.body as { captcha_key?: string; token?: string };

        const config = Config.get();

        const captcha = await checkCaptcha(config.register.requireCaptcha, captcha_key);
        if (captcha) return res.status(400).json(captcha);

        const invalid = () =>
            FieldErrors({
                token: {
                    message: req.t("auth:password_reset.INVALID_TOKEN"),
                    code: "INVALID_TOKEN",
                },
            });

        const decoded = readTicket<{ typ: string; uid?: string; email?: string }>(token, "email_verify");
        if (!decoded?.uid) throw invalid();

        const user = await User.findOne({
            where: { id: decoded.uid },
            select: { id: true, email: true, verified: true, disabled: true, deleted: true },
        });
        if (!user || user.disabled || user.deleted || !user.email || user.email !== decoded.email) throw invalid();

        if (!user.verified) {
            await User.update({ id: user.id }, { verified: true });
            await emitUserUpdate(user.id);
            await emitRequiredAction(user.id);
        }

        res.json({
            user_id: user.id,
            token: req.user_id === user.id && req.headers.authorization ? req.headers.authorization : await generateToken(user.id),
        });
    },
);

export default router;
