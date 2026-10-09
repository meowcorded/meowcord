import { Config } from "@spacebar/util";
import { CaptchaRequiredResponse } from "@spacebar/schemas";

export interface CaptchaVerifyResult {
    success: boolean;
    "error-codes"?: string[];
}

const CORE_ENDPOINT = "/api/v9/auth/cap/";

export function capEndpoint() {
    const { capMode, sitekey, secret, instance } = Config.get().security.captcha;
    if (capMode !== "standalone") return CORE_ENDPOINT;
    if (!sitekey || !secret || !instance) return null;
    return `${instance.replace(/\/+$/, "")}/${encodeURIComponent(sitekey)}/`;
}

export function captchaEnabled() {
    return Config.get().security.captcha.enabled && !!capEndpoint();
}

export function capSitekey() {
    return capEndpoint() === CORE_ENDPOINT ? "fosscord" : Config.get().security.captcha.sitekey!;
}

const verifyCap = async (response: string, secret: string): Promise<CaptchaVerifyResult> => {
    const res = await fetch(`${capEndpoint()}siteverify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, response }),
        signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) return { success: false, "error-codes": ["captcha-unreachable"] };
    const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        "error-codes"?: string[];
    };
    if (res.ok && body.success === true) return { success: true };
    return {
        success: false,
        "error-codes": body["error-codes"] ?? [body.error ?? "invalid-input-response"],
    };
};

export async function verifyCaptcha(response: string, consume = true): Promise<CaptchaVerifyResult> {
    const endpoint = capEndpoint();
    if (!endpoint) throw new Error("Cap Standalone is not configured. It needs a server URL, site key and secret.");
    if (endpoint === CORE_ENDPOINT) {
        const { consumeRegistrationToken, registrationTokenAvailable } = await import("./localCap.js");
        return { success: await (consume ? consumeRegistrationToken(response) : registrationTokenAvailable(response)) };
    }
    return verifyCap(response, Config.get().security.captcha.secret!);
}

const challenge = (codes: string[]): CaptchaRequiredResponse => ({
    captcha_key: codes,
    captcha_sitekey: capSitekey(),
    captcha_service: "cap",
});

export async function checkCaptcha(required: boolean, response: string | null | undefined): Promise<CaptchaRequiredResponse | null> {
    if (!required || !captchaEnabled()) return null;
    if (!response || typeof response !== "string" || response.length > 512) return challenge(["captcha-required"]);
    const verify = await verifyCaptcha(response);
    return verify.success ? null : challenge(verify["error-codes"] ?? ["invalid-input-response"]);
}

export function registrationCapEndpoint() {
    const endpoint = capEndpoint();
    if (!endpoint) throw new Error("Cap Standalone needs its server URL, site key and secret before signup can verify accounts");
    return endpoint;
}

export async function checkRegistrationCaptcha(response: string | null | undefined, consume = true): Promise<CaptchaRequiredResponse | null> {
    if (!Config.get().register.requireCaptcha) return null;
    registrationCapEndpoint();
    if (!response || typeof response !== "string" || response.length > 512) return challenge(["captcha-required"]);
    const verified = await verifyCaptcha(response, consume);
    return verified.success ? null : challenge(verified["error-codes"] ?? ["invalid-input-response"]);
}
