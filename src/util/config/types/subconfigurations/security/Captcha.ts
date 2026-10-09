export class CaptchaConfiguration {
    capMode: "core" | "standalone" = "core";
    enabled: boolean = false;
    sitekey: string | null = null;
    secret: string | null = null;
    instance: string | null = null;
}
