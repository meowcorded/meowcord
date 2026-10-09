export interface CaptchaConfigResponse {
    service: "cap" | null;
    sitekey: string | null;
    endpoint: string | null;
    register: boolean;
    login: boolean;
    password_reset: boolean;
}
