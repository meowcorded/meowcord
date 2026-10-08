import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { e2eeRateLimit } from "@spacebar/api/util";
import { resolveSoundmoji } from "../../util/utility/Soundboard";

const router: Router = Router({ mergeParams: true });

// Soundmojis for encrypted chats: the server can't see the message, so the client sends only the sound ids it found
// after decrypting ("guild_id:sound_id", 0 for the default sounds) and gets back what it would have attached itself
router.post("/", e2eeRateLimit("e2ee_soundmoji", 60, 60), route({ spacebarOnly: true }), async (req: Request, res: Response) => {
    const raw = (req.body as { refs?: unknown })?.refs;
    const refs = [...new Set(Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string" && /^\d{1,20}:\d{1,20}$/.test(r)) : [])].slice(0, 25);
    const sounds = refs.length ? await resolveSoundmoji(refs.map((ref) => `<sound:${ref}>`).join(" ")) : null;
    res.json({ sounds: sounds ?? [] });
});

export default router;
