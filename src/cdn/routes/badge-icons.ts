import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Router, Response, Request } from "express";
import { fileTypeFromBuffer } from "file-type";
import { ASSETS_FOLDER, Config, isRequestSignature } from "@spacebar/util";
import { HTTPError } from "lambert-server/HTTPError";
import { storage, internalUpload, setCacheControl, setCacheControlNotFound, fetchUpstreamAsset, safeMediaType } from "../util";

const BUNDLED_BADGES = path.join(ASSETS_FOLDER, "badge-icons");
const ALLOWED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"];

const router = Router({ mergeParams: true });

// custom instance badges; clients always request `<icon>.png`, whatever the real format is
router.post(
    "/",
    internalUpload(async (req: Request, res: Response) => {
        if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");
        if (!req.file) throw new HTTPError("Missing file");
        const { buffer, size } = req.file;

        const type = await fileTypeFromBuffer(buffer);
        if (!type || !ALLOWED_MIME_TYPES.includes(type.mime)) throw new HTTPError("Invalid file type");

        const hash = crypto.createHash("md5").update(buffer).digest("hex");
        await storage.set(`badge-icons/${hash}.png`, buffer);

        return res.json({
            id: hash,
            content_type: type.mime,
            size,
            url: `${Config.get().cdn.endpointPublic}${req.baseUrl}/${hash}.png`,
        });
    }),
);

router.get("/:badge_id", setCacheControl, async (req: Request, res: Response) => {
    res.removeHeader("Set-Cookie");
    const { badge_id } = req.params as { [key: string]: string };
    if (!/^[\w-]+\.png$/.test(badge_id)) return setCacheControlNotFound(req, res);
    const key = `badge-icons/${badge_id}`;
    const stored = await storage.get(key);
    if (!stored) {
        const png = await fs.readFile(path.join(BUNDLED_BADGES, badge_id)).catch(() => null);
        if (png) return res.type("image/png").send(png);
        const svg = await fs.readFile(path.join(BUNDLED_BADGES, `${path.basename(badge_id, ".png")}.svg`)).catch(() => null);
        if (svg) return res.type("image/svg+xml").send(svg);
    }
    const file = stored ?? (/^[0-9a-f]{32}\.png$/.test(badge_id) ? await fetchUpstreamAsset(key, `https://cdn.discordapp.com/badge-icons/${badge_id}`) : null);
    if (!file) return setCacheControlNotFound(req, res);
    const type = await fileTypeFromBuffer(file);

    res.set("Content-Type", safeMediaType(type?.mime));

    return res.send(file);
});

export default router;
