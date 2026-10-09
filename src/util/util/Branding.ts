import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Response } from "express";
import { Config } from "./Config";
import { ASSETS_FOLDER } from "./Constants";
import { DEFAULT_AVATAR_COLORS } from "./DefaultAvatars";
import { BrandAssetCache } from "./BrandAssetCache";
import { fetchBrandAsset, readBrandAssetFile, withinBrandImageLimits } from "./BrandAssetRequest";
import { DEFAULT_INSTANCE_NAME } from "../config/types/ClientConfiguration";

export const INSTANCE_ICON_PATH =
    "M2.5 9.5C2.5 7.5 3 4.5 4.2 3.2C4.8 2.6 5.6 2.7 6.1 3.2L8.6 5.8C10.8 5.3 13.2 5.3 15.4 5.8L17.9 3.2C18.4 2.7 19.2 2.6 19.8 3.2C21 4.5 21.5 7.5 21.5 9.5L21.5 13.5C21.5 18.2 17.5 20.8 12 20.8C6.5 20.8 2.5 18.2 2.5 13.5ZM6.5 13a1.9 2.5 0 1 0 3.8 0a1.9 2.5 0 1 0 -3.8 0ZM13.7 13a1.9 2.5 0 1 0 3.8 0a1.9 2.5 0 1 0 -3.8 0Z";
export const INSTANCE_WHISKERS_PATH =
    "M3.779 14.08L0.879 13.08A0.55 0.55 0 0 0 0.521 14.12L3.421 15.12A0.55 0.55 0 0 0 3.779 14.08ZM3.444 16.073L0.744 16.873A0.55 0.55 0 0 0 1.056 17.927L3.756 17.127A0.55 0.55 0 0 0 3.444 16.073ZM20.579 15.12L23.479 14.12A0.55 0.55 0 0 0 23.121 13.08L20.221 14.08A0.55 0.55 0 0 0 20.579 15.12ZM20.244 17.127L22.944 17.927A0.55 0.55 0 0 0 23.256 16.873L20.556 16.073A0.55 0.55 0 0 0 20.244 17.127Z";
export const DEFAULT_FAVICON_FILE = path.join(ASSETS_FOLDER, "public", "branding", "favicon.svg");

export const DEFAULT_ICON_FILE = path.join(ASSETS_FOLDER, "icon.png");

export type BrandImage = { url: string } | { file: string };

export const resolveBrandImage = (value?: string | null): BrandImage | null => {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
    const file = path.resolve(ASSETS_FOLDER, "..", trimmed);
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? { file } : null;
};

export const instanceIcon = () => resolveBrandImage(Config.get().client.icon) ?? resolveBrandImage(Config.get().general.image);

export const instanceLogo = () => resolveBrandImage(Config.get().client.logo);

export const instanceName = () => Config.get().client.instanceName || Config.get().general.instanceName || DEFAULT_INSTANCE_NAME;

export const helpUrl = () => {
    const url = Config.get().client.helpUrl?.trim();
    return url && /^https?:\/\//i.test(url) ? url : null;
};

const fileVersion = (file: string) => {
    const stat = fs.statSync(file, { throwIfNoEntry: false, bigint: true });
    return stat?.isFile() ? `${file}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}` : null;
};

const version = (image: BrandImage) =>
    createHash("sha1")
        .update("file" in image ? (fileVersion(image.file) ?? JSON.stringify(image)) : JSON.stringify(image))
        .digest("hex")
        .slice(0, 8);

export const brandImageUrls = () => {
    const icon = instanceIcon();
    const logo = instanceLogo();
    return {
        icon: icon ? `/static/logo.png?v=${version(icon)}` : null,
        logo: logo ? `/static/wordmark?v=${version(logo)}` : null,
    };
};

export const BRAND_COLOR = "#7B5CFF";

export const instanceIconTile = () => {
    const { icon } = brandImageUrls();
    if (icon) return `<img class="brand-icon" src="${escapeXml(icon)}" alt="" />`;
    return `<svg class="brand-icon" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="15" fill="${BRAND_COLOR}"/><g transform="translate(6 6) scale(1.5)" fill="#fff"><path fill-rule="evenodd" d="${INSTANCE_ICON_PATH}"/><path d="${INSTANCE_WHISKERS_PATH}"/></g></svg>`;
};

export const brandPage = (html: string) => html.replaceAll("__INSTANCE_NAME__", escapeXml(instanceName())).replaceAll("__INSTANCE_ICON__", instanceIconTile());

export const sendBrandImage = (res: Response, image: BrandImage, cacheControl = "public, max-age=21600") => {
    res.set("Cache-Control", cacheControl);
    if ("url" in image) return res.redirect(302, image.url);
    return res.sendFile(image.file, { cacheControl: false, dotfiles: "allow" });
};

const iconDataUris = new BrandAssetCache<string>();

const MIME_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
};

const fetchDataUri = async (url: string) => {
    const asset = await fetchBrandAsset(url, true);
    return asset ? `data:${asset.type};base64,${asset.data.toString("base64")}` : null;
};

export const instanceIconDataUri = async () => {
    const icon = instanceIcon();
    if (!icon) return null;
    if ("file" in icon) {
        const fingerprint = fileVersion(icon.file);
        if (!fingerprint) return null;
        return iconDataUris.get(`file:${fingerprint}`, async () => {
            const data = await readBrandAssetFile(icon.file);
            return data ? `data:${MIME_TYPES[path.extname(icon.file).toLowerCase()] ?? "image/png"};base64,${data.toString("base64")}` : null;
        });
    }
    return iconDataUris.get(`url:${icon.url}`, () => fetchDataUri(icon.url));
};

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const iconMarkup = (x: number, y: number, size: number, iconUri: string | null) =>
    iconUri
        ? `<image href="${escapeXml(iconUri)}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`
        : `<g fill="#fff" transform="translate(${x} ${y}) scale(${size / 24})"><path fill-rule="evenodd" d="${INSTANCE_ICON_PATH}"/><path d="${INSTANCE_WHISKERS_PATH}"/></g>`;

export const wordmarkSvg = (box?: [number, number], iconUri: string | null = null) => {
    const name = instanceName();
    const width = Math.ceil(34 + [...name].length * 12.5);
    const [boxWidth, boxHeight] = box ?? [width, 24];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${boxWidth}" height="${boxHeight}" viewBox="0 0 ${width} 24" fill="none">${iconMarkup(0, 0, 24, iconUri)}<text x="32" y="19.5" fill="#fff" font-family="'gg sans','Noto Sans','Helvetica Neue',Helvetica,Arial,sans-serif" font-size="20" font-weight="800">${escapeXml(name)}</text></svg>`;
};

export const qrLogoSvg = (iconUri: string | null = null) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#000"/>${iconMarkup(23, 23, 54, iconUri)}</svg>`;

export const placeholderAvatarSvg = (size: number, background: string, foreground: string, iconUri: string | null = null) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256"><circle cx="128" cy="128" r="128" fill="${background}"/>${
        iconUri
            ? `<image href="${escapeXml(iconUri)}" x="62" y="62" width="132" height="132" preserveAspectRatio="xMidYMid meet" opacity="0.6"/>`
            : `<g fill="${foreground}" transform="translate(62 62) scale(5.5)"><path fill-rule="evenodd" d="${INSTANCE_ICON_PATH}"/><path d="${INSTANCE_WHISKERS_PATH}"/></g>`
    }</svg>`;

export const APP_THEME_COLOR = "#121214";

const appIcons = new BrandAssetCache<Buffer>();

const renderAppIcon = async (image: BrandImage, size: number) => {
    const { Jimp } = await import("jimp");
    const source = "file" in image ? await readBrandAssetFile(image.file) : (await fetchBrandAsset(image.url))?.data;
    if (!source || !withinBrandImageLimits(source)) return null;
    const icon = await Jimp.read(source);
    if ("file" in image && image.file === DEFAULT_ICON_FILE) return icon.resize({ w: size, h: size }).getBuffer("image/png");
    const inner = Math.round(size * 0.62);
    icon.scaleToFit({ w: inner, h: inner });
    const canvas = new Jimp({
        width: size,
        height: size,
        color: parseInt(`${APP_THEME_COLOR.slice(1)}ff`, 16),
    });
    canvas.composite(icon, Math.round((size - icon.bitmap.width) / 2), Math.round((size - icon.bitmap.height) / 2));
    return canvas.getBuffer("image/png");
};

export const appIconPng = (size: number) => {
    if (![180, 192, 512].includes(size)) return Promise.resolve(null);
    const image = instanceIcon() ?? { file: DEFAULT_ICON_FILE };
    const key = `${version(image)}:${size}`;
    return appIcons.get(key, () => renderAppIcon(image, size)).then((png) => png ?? appIcons.get(`default:${size}`, () => renderAppIcon({ file: DEFAULT_ICON_FILE }, size)));
};

export const appIconUrl = (size: number) => `/assets/pwa/icon-${size}.png?v=${version(instanceIcon() ?? { file: DEFAULT_ICON_FILE })}`;

const EMAIL_IMAGE_SIDES = { icon: 144, wordmark: 800 };

export type EmailImage = keyof typeof EMAIL_IMAGE_SIDES;

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const emailImages = new BrandAssetCache<Buffer>();

export const emailImageSource = (kind: EmailImage) => (kind === "icon" ? (instanceIcon() ?? { file: DEFAULT_ICON_FILE }) : instanceLogo());

const renderEmailPng = async (image: BrandImage, side: number) => {
    const source = "file" in image ? await readBrandAssetFile(image.file) : (await fetchBrandAsset(image.url))?.data;
    if (!source) return null;
    if (source.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return source;
    const sharp = (await import("sharp")).default;
    const input = { limitInputPixels: 16777216, animated: false };
    const { format } = await sharp(source, input).metadata();
    return sharp(source, input)
        .resize({ width: side, height: side, fit: "inside", withoutEnlargement: format !== "svg" })
        .png()
        .timeout({ seconds: 5 })
        .toBuffer();
};

export const emailImagePng = (kind: EmailImage) => {
    const image = emailImageSource(kind);
    return image ? emailImages.get(`${kind}:${version(image)}`, () => renderEmailPng(image, EMAIL_IMAGE_SIDES[kind])) : Promise.resolve(null);
};

export const emailImageUrls = () => {
    const logo = instanceLogo();
    return {
        icon: `/static/email/icon.png?v=${version(instanceIcon() ?? { file: DEFAULT_ICON_FILE })}`,
        logo: logo ? `/static/email/wordmark.png?v=${version(logo)}` : null,
    };
};

export const appManifest = () => {
    const name = instanceName();
    return {
        id: "/app",
        name,
        short_name: name,
        start_url: "/app",
        scope: "/",
        display: "standalone",
        background_color: APP_THEME_COLOR,
        theme_color: APP_THEME_COLOR,
        icons: [192, 512].flatMap((size) =>
            ["any", "maskable"].map((purpose) => ({
                src: appIconUrl(size),
                sizes: `${size}x${size}`,
                type: "image/png",
                purpose,
            })),
        ),
    };
};

export const defaultAvatarSvg = (index: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="${DEFAULT_AVATAR_COLORS[index % DEFAULT_AVATAR_COLORS.length]}"/><g fill="#fff" transform="translate(53 54) scale(6.25)"><path fill-rule="evenodd" d="${INSTANCE_ICON_PATH}"/><path d="${INSTANCE_WHISKERS_PATH}"/></g></svg>`;
