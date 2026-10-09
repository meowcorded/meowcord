import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { revokeStaleE2eeDevices } from "@spacebar/api/util";
import { PushDevice, Session } from "@spacebar/database";
import { emitEvent } from "@spacebar/util";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        responses: {
            204: {},
        },
        allowUnverified: true,
    }),
    async (req: Request, res: Response) => {
        const { provider, token } = req.body as { provider?: string | null; token?: string | null };
        if (provider && token) {
            const endpoint = (() => {
                try {
                    return String((JSON.parse(token) as { endpoint?: string }).endpoint ?? token);
                } catch {
                    return token;
                }
            })();
            await PushDevice.delete({
                user_id: req.user_id,
                provider: provider.toLowerCase(),
                token: endpoint,
            });
        }

        const session_id = req.session?.session_id;
        if (req.session) await Session.remove(req.session);

        res.status(204).send();

        if (!session_id) return;
        await emitEvent({
            session_id,
            event: "SB_SESSION_REMOVE",
            origin: "Self logout",
        });
        await revokeStaleE2eeDevices(req.user_id);
    },
);

export default router;
