import { timingSafeEqual } from "node:crypto";

export function tokenEquals(given: unknown, expected: unknown) {
    if (typeof given !== "string" || typeof expected !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
