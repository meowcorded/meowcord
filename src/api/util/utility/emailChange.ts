import crypto from "node:crypto";
import { tokenEquals } from "./tokenEquals";

const TTL = 10 * 60 * 1000;
const codes = new Map<string, { code: string; expires: number; attempts: number }>();
const tokens = new Map<string, { token: string; expires: number }>();

export const EmailChange = {
    createCode(user_id: string) {
        const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
        codes.set(user_id, { code, expires: Date.now() + TTL, attempts: 0 });
        return code;
    },

    verifyCode(user_id: string, code: string) {
        const entry = codes.get(user_id);
        if (!entry || entry.expires < Date.now()) return undefined;
        if (!tokenEquals(code.trim(), entry.code)) {
            if (++entry.attempts >= 5) codes.delete(user_id);
            return undefined;
        }
        codes.delete(user_id);
        const token = crypto.randomBytes(24).toString("base64url");
        tokens.set(user_id, { token, expires: Date.now() + TTL });
        return token;
    },

    consumeToken(user_id: string, token: string) {
        const entry = tokens.get(user_id);
        if (!entry || entry.expires < Date.now() || !tokenEquals(token, entry.token)) return false;
        tokens.delete(user_id);
        return true;
    },
};
