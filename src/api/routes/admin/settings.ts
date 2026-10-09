import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { captchaEnabled } from "@spacebar/api/util";
import { Config } from "@spacebar/util";
import { HTTPError } from "lambert-server/HTTPError";
import { AdminSettingsUpdateSchema } from "@spacebar/schemas";

import { validateLoadingSvg, validateLoadingTips } from "@spacebar/util/util/LoadingScreen";

const router = Router({ mergeParams: true });

const pickRate = ({ count, window }: { count: number; window: number }) => ({ count, window });

const pickSettings = () => {
    const { general, client, register, login, passwordReset, security, limits, guild, externalRequests, user, defaults } = Config.get();
    const { captcha } = security;
    return {
        user: { identityBlockedTerms: user.identityBlockedTerms },
        general: {
            instanceName: general.instanceName,
            instanceDescription: general.instanceDescription,
            image: general.image,
            frontPage: general.frontPage,
            tosPage: general.tosPage,
            privacyPage: general.privacyPage,
            guidelinesPage: general.guidelinesPage,
            correspondenceEmail: general.correspondenceEmail,
            correspondenceUserID: general.correspondenceUserID,
        },
        client: {
            instanceName: client.instanceName,
            icon: client.icon,
            logo: client.logo,
            helpUrl: client.helpUrl,
            activityApplicationHost: client.activityApplicationHost,
            loadingTips: client.loadingTips,
            loadingSvg: client.loadingSvg,
        },
        register: {
            disabled: register.disabled,
            allowNewRegistration: register.allowNewRegistration,
            requireInvite: register.requireInvite,
            guestsRequireInvite: register.guestsRequireInvite,
            requireCaptcha: register.requireCaptcha,
            allowMultipleAccounts: register.allowMultipleAccounts,
            incrementingDiscriminators: register.incrementingDiscriminators,
            blacklistedUsernames: register.blacklistedUsernames ?? [],
            email: { required: register.email.required },
            dateOfBirth: { minimum: register.dateOfBirth.minimum },
            password: {
                minLength: register.password.minLength,
                minNumbers: register.password.minNumbers,
                minUpperCase: register.password.minUpperCase,
                minSymbols: register.password.minSymbols,
            },
        },
        login: { requireCaptcha: login.requireCaptcha, requireVerification: login.requireVerification },
        defaults: { user: { verified: defaults.user.verified } },
        passwordReset: { requireCaptcha: passwordReset.requireCaptcha },
        captcha: {
            capMode: captcha.capMode,
            enabled: captcha.enabled,
            sitekey: captcha.sitekey,
            instance: captcha.instance,
            secret_set: !!captcha.secret,
            active: captchaEnabled(),
        },
        rate: {
            enabled: limits.rate.enabled,
            ip: pickRate(limits.rate.ip),
            global: pickRate(limits.rate.global),
            error: pickRate(limits.rate.error),
            login: pickRate(limits.rate.routes.auth.login),
            register: pickRate(limits.rate.routes.auth.register),
        },
        externalRequests: { ...externalRequests },
        e2ee: { ...limits.e2ee },
        limits: {
            user: { ...limits.user },
            guild: { ...limits.guild },
            message: { ...limits.message },
            channel: { ...limits.channel },
        },
        guild: {
            defaultFeatures: guild.defaultFeatures,
            publicThreadsInvitable: guild.publicThreadsInvitable,
            discovery: { hideJoinedGuilds: guild.discovery.hideJoinedGuilds },
        },
    };
};

const assertVerificationRequiresEmail = (body: AdminSettingsUpdateSchema) => {
    const { login, register } = Config.get();
    if (!(body.login?.requireVerification ?? login.requireVerification)) return;
    if (!(body.register?.email?.required ?? register.email.required)) throw new HTTPError("Require an email address at sign-up before requiring a verified email", 400);
};

const blankToNull = (value: unknown) => (typeof value === "string" ? value.trim() || null : value);
const nullBlanks = <T extends object>(section: T | undefined, keep: string[] = []) =>
    Object.fromEntries(Object.entries(section ?? {}).map(([k, v]) => [k, keep.includes(k) ? v : blankToNull(v)]));

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Get the instance settings editable from the admin dashboard",
    }),
    (req: Request, res: Response) => {
        res.json(pickSettings());
    },
);

router.patch(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminSettingsUpdateSchema",
        description: "Update instance information, client branding, registration, captcha, rate limits and e2ee limits",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminSettingsUpdateSchema;
        const identityBlockedTerms = body.user?.identityBlockedTerms;
        if (
            identityBlockedTerms !== undefined &&
            (identityBlockedTerms.length > 256 || identityBlockedTerms.some((term) => term.length > 64 || !/^[\p{L}\p{N}]+$/u.test(term.trim())))
        )
            throw new HTTPError("Blocked identity names must contain up to 256 words of up to 64 letters or numbers", 400);
        const general = nullBlanks(body.general);
        if (typeof body.general?.instanceName === "string") {
            if (body.general.instanceName.trim()) general.instanceName = body.general.instanceName.trim();
            else delete general.instanceName;
        }
        const client = nullBlanks(body.client);
        if (typeof body.client?.instanceName === "string") {
            if (body.client.instanceName.trim()) client.instanceName = body.client.instanceName.trim();
            else delete client.instanceName;
        }

        if (body.client?.loadingSvg !== undefined) client.loadingSvg = validateLoadingSvg(body.client.loadingSvg);
        if (body.client?.loadingTips !== undefined) client.loadingTips = validateLoadingTips(body.client.loadingTips);

        const captcha: Record<string, unknown> = nullBlanks(body.captcha, ["secret"]);
        if (typeof captcha.secret === "string") {
            if (captcha.secret.trim()) captcha.secret = captcha.secret.trim();
            else delete captcha.secret;
        }
        if (typeof captcha.instance === "string") captcha.instance = captcha.instance.replace(/\/+$/, "");

        const nextCaptcha = { ...Config.get().security.captcha, ...captcha };
        if (nextCaptcha.capMode === "standalone") {
            if (!nextCaptcha.instance || !nextCaptcha.sitekey || !nextCaptcha.secret)
                throw new HTTPError("Cap Standalone requires a server URL, site key and secret. Choose Cap core to run verification locally.", 400);
            let url: URL;
            try {
                url = new URL(String(nextCaptcha.instance));
            } catch {
                throw new HTTPError("Enter a valid Cap Standalone server URL", 400);
            }
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                throw new HTTPError("Use an HTTP or HTTPS Cap Standalone URL without credentials, query parameters or a fragment", 400);
        }

        assertVerificationRequiresEmail(body);

        const { login, register: registerRate, ...rate } = body.rate ?? {};

        // a list replaces the old one; merging would keep entries that were taken off it
        const { blacklistedUsernames, ...register } = body.register ?? {};
        if (blacklistedUsernames) Config.get().register.blacklistedUsernames = [...new Set(blacklistedUsernames.map((name) => name.trim().toLowerCase()).filter(Boolean))];

        if (body.guild?.defaultFeatures) Config.get().guild.defaultFeatures = [...new Set(body.guild.defaultFeatures.map((value) => value.trim().toUpperCase()).filter(Boolean))];
        if (body.client?.loadingTips !== undefined) Config.get().client.loadingTips = client.loadingTips as string[] | null;
        if (identityBlockedTerms !== undefined) Config.get().user.identityBlockedTerms = [...new Set(identityBlockedTerms.map((term) => term.trim()))];
        await Config.set({
            general,
            client,
            externalRequests: body.externalRequests ?? {},
            guild: {
                ...(body.guild?.publicThreadsInvitable === undefined ? {} : { publicThreadsInvitable: body.guild.publicThreadsInvitable }),
                ...(body.guild?.discovery?.hideJoinedGuilds === undefined ? {} : { discovery: { hideJoinedGuilds: body.guild.discovery.hideJoinedGuilds } }),
            },
            register,
            login: body.login ?? {},
            defaults: body.defaults ?? {},
            passwordReset: body.passwordReset ?? {},
            security: { captcha },
            limits: {
                ...body.limits,
                rate: {
                    ...rate,
                    routes: {
                        auth: {
                            ...(login ? { login } : {}),
                            ...(registerRate ? { register: registerRate } : {}),
                        },
                    },
                },
                e2ee: body.e2ee ?? {},
            },
        } as unknown as Parameters<typeof Config.set>[0]);
        res.json(pickSettings());
    },
);

export default router;
