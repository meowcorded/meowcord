export class RgbValue {
    r: number;
    g: number;
    b: number;
    constructor(r: number, g: number, b: number) {
        this.r = r;
        this.g = g;
        this.b = b;
    }

    public asHex(withSigil: boolean = true) {
        return `${withSigil ? "#" : ""}${this.r.toString(16).toUpperCase()}${this.g.toString(16).toUpperCase()}${this.b.toString(16).toUpperCase()}`;
    }

    public asAnsiEscapeSequence() {
        return `\x1b[38;2;${this.r};${this.g};${this.b}m`;
    }
}

export class ColorUtils {
    public static cnv8To24(val: number): RgbValue {
        return new RgbValue((val >> 5) * 32, ((val & 28) >> 2) * 32, (val & 3) * 64);
    }
}

export const ANSI_ESC = "\x1b";
export const ANSI_RESET = "\x1b[0m";
export const ANSI_SEQUENCE_PATTERN = new RegExp(`${ANSI_ESC}\\[[0-9;]*m`, "g");

export enum AnsiFormat {
    Normal = 0,
    Bold = 1,
    Underline = 4,
}

export enum AnsiForeground {
    Gray = 30,
    Red = 31,
    Green = 32,
    Yellow = 33,
    Blue = 34,
    Pink = 35,
    Cyan = 36,
    White = 37,
}

export enum AnsiBackground {
    FireflyDarkBlue = 40,
    Orange = 41,
    MarbleBlue = 42,
    GreyishTurquoise = 43,
    Gray = 44,
    Indigo = 45,
    LightGray = 46,
    White = 47,
}

export interface AnsiStyle {
    format?: AnsiFormat | AnsiFormat[];
    foreground?: AnsiForeground;
    background?: AnsiBackground;
    foregroundRgb?: [number, number, number];
    backgroundRgb?: [number, number, number];
}

function clampChannel(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(255, Math.max(0, Math.floor(value)));
}

function styleCodes(style: AnsiStyle) {
    const codes: number[] = [];
    const formats = style.format === undefined ? [] : Array.isArray(style.format) ? style.format : [style.format];
    for (const format of formats) codes.push(format);
    if (style.foreground !== undefined) codes.push(style.foreground);
    if (style.background !== undefined) codes.push(style.background);
    if (style.foregroundRgb !== undefined) {
        const [r, g, b] = style.foregroundRgb;
        codes.push(38, 2, clampChannel(r), clampChannel(g), clampChannel(b));
    }
    if (style.backgroundRgb !== undefined) {
        const [r, g, b] = style.backgroundRgb;
        codes.push(48, 2, clampChannel(r), clampChannel(g), clampChannel(b));
    }
    return codes;
}

export function ansiSequence(codes: number[]) {
    return `${ANSI_ESC}[${codes.join(";")}m`;
}

export function styleAnsiText(text: string, style: AnsiStyle) {
    const codes = styleCodes(style);
    if (codes.length === 0) return text;
    return `${ansiSequence(codes)}${text}${ANSI_RESET}`;
}

export function foregroundAnsiText(text: string, foreground: AnsiForeground, format?: AnsiFormat | AnsiFormat[]) {
    return styleAnsiText(text, format === undefined ? { foreground } : { foreground, format });
}

export function truecolorAnsiText(text: string, r: number, g: number, b: number, format?: AnsiFormat | AnsiFormat[]) {
    const style: AnsiStyle = { foregroundRgb: [r, g, b] };
    if (format !== undefined) style.format = format;
    return styleAnsiText(text, style);
}

export function stripAnsiSequences(text: string) {
    return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

export function containsAnsiSequences(text: string) {
    ANSI_SEQUENCE_PATTERN.lastIndex = 0;
    return ANSI_SEQUENCE_PATTERN.test(text);
}

export function wrapAnsiCodeBlock(body: string) {
    return `\`\`\`ansi\n${body}\n\`\`\``;
}
