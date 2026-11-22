import { Config, corsProxyUrl, extractVideoFrame, fetchPublicUrl, reserveVideoFrame, verifyExternalPath } from "@spacebar/util";
import { Request, Response } from "express";

const MAX_SIZE = 50 * 1024 * 1024;
const PASSTHROUGH_HEADERS = ["content-range", "accept-ranges", "last-modified", "etag"];
const MEDIA_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "audio/mpeg",
    "audio/mp4",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/flac",
    "audio/aac",
]);
const SANDBOX_POLICY = "sandbox; default-src 'none'";

let active = 0;
const activeByIp = new Map<string, number>();

export async function ExternalProxy(req: Request, res: Response) {
    const ip = req.ip ?? "unknown";
    const mine = activeByIp.get(ip) ?? 0;
    if (mine >= 2 || active >= 8) return res.status(503).setHeader("retry-after", "1").send("Media proxy is busy");
    activeByIp.set(ip, mine + 1);
    active++;
    try {
        return await serveExternalProxy(req, res);
    } finally {
        active--;
        const left = (activeByIp.get(ip) ?? 1) - 1;
        if (left) activeByIp.set(ip, left);
        else activeByIp.delete(ip);
    }
}

async function serveExternalProxy(req: Request, res: Response) {
    const [, , hash, ...rest] = req.originalUrl.split("?")[0].split("/");
    const path = rest.join("/");
    if (!hash || !verifyExternalPath(hash, path)) return res.status(403).send("Invalid signature");

    const search = rest[0]?.startsWith("%3F") ? decodeURIComponent(rest.shift()!) : "";
    const [protocol, ...location] = rest;
    if (protocol !== "https" && protocol !== "http") return res.status(400).send("Invalid protocol");

    let target: string;
    try {
        target = corsProxyUrl(new URL(`${protocol}://${location.join("/")}${search}`));
    } catch {
        return res.status(400).send("Invalid media URL");
    }
    if (req.query.format) {
        const head = await fetchPublicUrl(target, { method: "HEAD", redirect: "error" }, 0, { timeoutMs: 5000 }).catch(() => null);
        if (head?.headers.get("content-type")?.startsWith("video/")) {
            const release = reserveVideoFrame();
            if (!release) return res.status(503).setHeader("retry-after", "1").send("Preview capacity is busy");
            const frame = await fetchPublicUrl(target, { redirect: "error" }, 0, { maxBytes: MAX_SIZE, timeoutMs: 15000, firstByteMs: 5000 })
                .then(async (video) => (video.ok ? extractVideoFrame(Buffer.from(await video.arrayBuffer()), undefined, true) : null))
                .catch(() => null)
                .finally(release);
            if (!frame) return res.status(415).send("Unable to render a preview frame");
            res.setHeader("content-type", "image/jpeg");
            res.setHeader("content-security-policy", SANDBOX_POLICY);
            res.setHeader("x-content-type-options", "nosniff");
            res.setHeader("cache-control", `public, max-age=${Config.get().cdn.proxyCacheHeaderSeconds}`);
            res.setHeader("access-control-allow-origin", "*");
            res.setHeader("cross-origin-resource-policy", "cross-origin");
            return res.send(frame);
        }
    }

    const abort = new AbortController();
    const disconnected = () => {
        if (!res.writableEnded) abort.abort();
    };
    res.once("close", disconnected);
    try {
        const upstream = await fetchPublicUrl(
            target,
            {
                redirect: "error",
                headers: {
                    "user-agent": Config.get().embeds.defaultUserAgent ?? "Mozilla/5.0",
                    ...(req.headers.range && { range: req.headers.range }),
                },
                signal: abort.signal,
            },
            0,
            { maxBytes: MAX_SIZE, timeoutMs: 15000, firstByteMs: 5000 },
        );
        if (!upstream.ok) return res.status(upstream.status).send(`Media proxy responded with ${upstream.status}`);
        const type = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
        if (!MEDIA_TYPES.has(type)) return res.status(415).send("Unsupported media type");
        const body = Buffer.from(await upstream.arrayBuffer());
        res.status(upstream.status);
        for (const header of PASSTHROUGH_HEADERS) {
            const value = upstream.headers.get(header);
            if (value) res.setHeader(header, value);
        }
        res.setHeader("content-type", type);
        res.setHeader("content-security-policy", SANDBOX_POLICY);
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-length", String(body.length));
        res.setHeader("cache-control", `public, max-age=${Config.get().cdn.proxyCacheHeaderSeconds}`);
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("cross-origin-resource-policy", "cross-origin");
        res.end(body);
    } catch (error) {
        if (res.headersSent) res.destroy();
        else if (/byte limit/.test(String(error))) res.status(413).send("Media response too large");
        else res.status(502).send("Unable to reach media proxy");
    } finally {
        res.off("close", disconnected);
    }
}
