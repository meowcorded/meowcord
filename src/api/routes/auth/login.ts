import bcrypt from "bcrypt";
import { Request, Response, Router } from "express";
import { loginMfaResponse, captchaKeyFrom, checkCaptcha } from "@spacebar/api/util";
import { route } from "@spacebar/api/middlewares";
import { User } from "@spacebar/database";
import { Config, FieldErrors, generateToken } from "@spacebar/util";
import { AccountStandingState, LoginSchema } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        requestBody: "LoginSchema",
        responses: {
            200: {
                body: "LoginResponse",
            },
            400: {
                body: "APIErrorOrCaptchaResponse",
            },
        },
        authentication: "never",
    }),
    async (req: Request, res: Response) => {
        const { login, password, undelete } = req.body as LoginSchema;

        const config = Config.get();

        const captcha = await checkCaptcha(config.login.requireCaptcha, captchaKeyFrom(req));
        if (captcha) return res.status(400).json(captcha);

        const user = await User.findOneOrFail({
            where: User.loginWhere(login),
            select: {
                data: true,
                id: true,
                disabled: true,
                deleted: true,
                account_standing: true,
                totp_secret: true,
                mfa_enabled: true,
                webauthn_enabled: true,
                security_keys: true,
                verified: true,
            },
            relations: { security_keys: true, settings: true },
        }).catch(() => {
            throw FieldErrors({
                login: {
                    message: req.t("auth:login.INVALID_LOGIN"),
                    code: "INVALID_LOGIN",
                },
                password: {
                    message: req.t("auth:login.INVALID_LOGIN"),
                    code: "INVALID_LOGIN",
                },
            });
        });

        // the salt is saved in the password refer to bcrypt docs
        const same_password = await bcrypt.compare(password, user.data.hash || "");
        if (!same_password) {
            throw FieldErrors({
                login: {
                    message: req.t("auth:login.INVALID_LOGIN"),
                    code: "INVALID_LOGIN",
                },
                password: {
                    message: req.t("auth:login.INVALID_LOGIN"),
                    code: "INVALID_LOGIN",
                },
            });
        }

        if (!undelete && user.deleted)
            return res.status(400).json({
                message: "This account is scheduled for deletion.",
                code: 20011,
            });
        if (user.account_standing === AccountStandingState.SUSPENDED || (!undelete && user.disabled))
            return res.status(400).json({
                message: req.t("auth:login.ACCOUNT_DISABLED"),
                code: 20013,
            });

        const mfa = await loginMfaResponse(req, user, { undelete: !!undelete });
        if (mfa) return res.json(mfa);

        if (undelete) {
            // undelete refers to un'disable' here
            if (user.disabled) await User.update({ id: user.id }, { disabled: false });
            if (user.deleted) await User.update({ id: user.id }, { deleted: false });
        }

        const token = await generateToken(user.id);

        // Notice this will have a different token structure, than discord
        // Discord header is just the user id as string, which is not possible with npm-jsonwebtoken package
        // https://user-images.githubusercontent.com/6506416/81051916-dd8c9900-8ec2-11ea-8794-daf12d6f31f0.png

        res.json({
            user_id: user.id,
            token,
            user_settings: { locale: user.settings?.locale, theme: user.settings?.theme },
        });
    },
);

/**
 * POST /auth/login
 * @argument { login: "email@gmail.com", password: "cleartextpassword", undelete: false, captcha_key: null, login_source: null, gift_code_sku_id: null, }

 * MFA required:
 * @returns {"token": null, "mfa": true, "sms": true, "ticket": "SOME TICKET JWT TOKEN"}

 * WebAuthn MFA required:
 * @returns {"token": null, "mfa": true, "webauthn": true, "sms": true, "ticket": "SOME TICKET JWT TOKEN"}

 * Captcha required:
 * @returns {"captcha_key": ["captcha-required"], "captcha_sitekey": "fosscord", "captcha_service": "cap"}

 * Sucess:
 * @returns {"token": "USERTOKEN", "settings": {"locale": "en", "theme": "dark"}}

 */

export default router;
