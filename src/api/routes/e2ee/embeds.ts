import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { e2eeRateLimit } from "@spacebar/api/util";
import { getOrUpdateEmbedCache } from "../../util/utility/EmbedHandlers";
import type { Embed } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

// Link previews for encrypted chats: the client sends only the links it found after decrypting, never the message
router.post("/", e2eeRateLimit("e2ee_embeds", 30, 60), route({ spacebarOnly: true }), async (req: Request, res: Response) => {
    const raw = (req.body as { urls?: unknown })?.urls;
    const urls = [...new Set(Array.isArray(raw) ? raw.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u) && u.length < 2048) : [])].slice(0, 5);
    const embeds: Record<string, Embed[]> = {};
    if (urls.length) await getOrUpdateEmbedCache(urls, async (url, found) => void (embeds[url] = found));
    res.json({ embeds });
});

export default router;
