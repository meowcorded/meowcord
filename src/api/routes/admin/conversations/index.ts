import { sqlLike } from "@spacebar/database/Sql";
import { Router, Request, Response } from "express";
import { route } from "@spacebar/api/middlewares";
import { getDatabase } from "@spacebar/database";
import { getSystemAccount } from "@spacebar/api/util";
import { ChannelType } from "@spacebar/schemas";
import { HTTPError } from "lambert-server/HTTPError";

const router = Router({ mergeParams: true });
router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "List users with incoming Official support conversations first",
    }),
    async (req: Request, res: Response) => {
        res.set("Cache-Control", "no-store");
        const q = req.query.q ?? "";
        const offset = req.query.offset ?? "0";
        if (typeof q !== "string" || q.length > 100 || typeof offset !== "string" || !/^\d{1,7}$/.test(offset)) throw new HTTPError("Invalid user search or page", 400);
        const database = getDatabase();
        if (!database) throw new HTTPError("Database unavailable", 503);
        const official = await getSystemAccount("official");
        const search = q.trim();
        const pattern = `%${search.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        const rows = await database.query(
            `
        WITH conversations AS (
            SELECT channel.id AS channel_id, peer.user_id
            FROM channels channel
            JOIN recipients managed ON managed.channel_id = channel.id AND managed.user_id = $1
            JOIN recipients peer ON peer.channel_id = channel.id AND peer.user_id <> $1
            WHERE channel.type = $2 AND channel.guild_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM recipients extra WHERE extra.channel_id = channel.id AND extra.user_id NOT IN ($1, peer.user_id))
        ), activity AS (
            SELECT conversations.user_id, MIN(conversations.channel_id) AS channel_id,
                MAX(message.timestamp) AS last_message_at,
                MAX(message.timestamp) FILTER (WHERE message.author_id = conversations.user_id) AS last_incoming_at
            FROM conversations LEFT JOIN messages message ON message.channel_id = conversations.channel_id
            GROUP BY conversations.user_id
        )
        SELECT person.id, person.username, person.global_name, person.discriminator, person.avatar,
            activity.channel_id, activity.last_message_at, activity.last_incoming_at
        FROM users person LEFT JOIN activity ON activity.user_id = person.id
        WHERE person.deleted = false AND person.bot = false AND person.system = false AND person.id <> $1
            AND ($3 = '' OR CAST(person.id AS text) = $3 OR ${sqlLike("person.username", "$4")} OR ${sqlLike("person.global_name", "$4")})
        ORDER BY (activity.last_incoming_at IS NOT NULL) DESC, activity.last_incoming_at DESC NULLS LAST,
            activity.last_message_at DESC NULLS LAST, LOWER(person.username), person.id
        LIMIT 51 OFFSET $5`,
            [official.id, ChannelType.DM, search, pattern, Number(offset)],
        );
        res.json({
            users: rows.slice(0, 50).map((user: Record<string, unknown>) => ({
                ...user,
                has_replied: !!user.last_incoming_at,
            })),
            has_more: rows.length > 50,
            offset: Number(offset) + Math.min(rows.length, 50),
        });
    },
);
export default router;
