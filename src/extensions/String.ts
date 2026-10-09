import { SPECIAL_CHAR } from "@spacebar/util/util/Regex";
import { Random, ntob } from "@spacebar/extensions";

export function trimSpecial(str?: string): string {
    if (!str) return "";
    return str.replace(SPECIAL_CHAR, "").trim();
}

export function normalizeLineEndings(str?: string): string {
    if (!str) return "";
    return str.replace(/\r\n?/g, "\n");
}

/**
 * Capitalizes the first letter of a string.
 * @param str The string to capitalize.
 * @returns The capitalized string.
 */
export function capitalize(str: string): string {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function centerString(str: string, len: number): string {
    const pad = len - str.length;
    const padLeft = Math.floor(pad / 2) + str.length;
    return str.padStart(padLeft).padEnd(len);
}

export function stringGlobToRegexp(str: string, flags?: string): RegExp {
    // Convert simple wildcard patterns to regex
    const escaped = str.replace(".", "\\.").replace("?", ".").replace("*", ".*");
    return new RegExp(escaped, flags);
}

// TODO: use exception type
export function stringCheckLength(str: string, min: number, max: number, key: string) {
    if (str.length < min || str.length > max) {
        throw new StringLengthOutOfBoundsException({
            key,
            min,
            max,
            value: str,
        });
    }
}

export function generateCode() {
    return ntob(Date.now() + Random.nextInt(0, 10000));
}

export class StringLengthOutOfBoundsException extends RangeError {
    min: number;
    max: number;
    key: string;
    value: string;

    constructor(opts: { min: number; max: number; key: string; value: string }) {
        super(`String ${opts.key} must be between ${opts.min} and ${opts.max} characters`);
        Object.assign(this, opts);
    }
}
