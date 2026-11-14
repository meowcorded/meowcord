import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { getSearchableChannels, normalizeMessageSearchQuery, searchMessages, searchResponse, searchTabs } from "@spacebar/api/util";
import { getPermission } from "@spacebar/util";

const router: Router = Router({ mergeParams: true });

const channelIdsOf = (value: unknown) => (value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String));

router.get(
    "/",
    route({
        responses: {
            200: {
                body: "GuildMessagesSearchResponse",
            },
            403: {
                body: "APIErrorResponse",
            },
            422: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        (await getPermission(req.user_id, guild_id)).hasThrow("VIEW_CHANNEL");
        const query = normalizeMessageSearchQuery(req.query);
        const channels = await getSearchableChannels(req.user_id, guild_id, channelIdsOf(query.channel_id));
        res.json(searchResponse(req.user_id, await searchMessages(req.user_id, channels, query)));
    },
);

router.post(
    "/tabs",
    route({
        responses: {
            200: {},
            403: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const { guild_id } = req.params as { [key: string]: string };
        (await getPermission(req.user_id, guild_id)).hasThrow("VIEW_CHANNEL");
        const channels = await getSearchableChannels(req.user_id, guild_id, channelIdsOf(req.body.channel_ids));
        res.json(await searchTabs(req.user_id, channels, req.body));
    },
);

export default router;
