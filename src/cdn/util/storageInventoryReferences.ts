import { HTTPError } from "lambert-server/HTTPError";

export interface InventoryOwner {
    principal: string;
    category: "upload" | "managed" | "cache" | "legacy-unattributed";
}
export interface InventoryReferenceQuery {
    query(sql: string, parameters?: unknown[]): Promise<{ principal: string | null }[]>;
}
const unknown = (): InventoryOwner => ({
    principal: "system:legacy-unattributed",
    category: "legacy-unattributed",
});
const unique = (rows: { principal: string | null }[], category: InventoryOwner["category"]): InventoryOwner => {
    if (!rows.length || rows.some((row) => !row.principal || !/^(?:user|webhook|application):\d+$/.test(row.principal))) return unknown();
    const owners = new Set(rows.map((row) => row.principal!));
    return owners.size === 1 ? { principal: [...owners][0], category } : unknown();
};
export class StorageInventoryReferences {
    constructor(private database: InventoryReferenceQuery) {}
    async resolve(path: string): Promise<InventoryOwner> {
        if (!path || path.length > 2048 || /[\\\0]/.test(path) || !path.split("/").every((part) => part && part !== "." && part !== ".."))
            throw new HTTPError("Invalid inventory locator", 400);
        if (/^(?:collectibles-shop-upstream|avatar-decoration-presets|krisp_browser_models|content-assets)\//.test(path)) return { principal: "system:cache", category: "cache" };
        if (/^collectibles-shop\//.test(path)) return { principal: "system:managed", category: "managed" };
        if (path.startsWith("attachments/")) {
            const stage = /^attachments\/(\d+)\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
            if (stage) {
                const staged = await this.database.query(
                    `SELECT CASE WHEN u.id IS NOT NULL THEN 'user:' || CAST(u.id AS text) ELSE NULL END AS principal
                    FROM cloud_attachments c LEFT JOIN users u ON u.id=c.user_id
                    WHERE c.upload_filename=$1 AND c.channel_id=$2 AND c.user_attachment_id=$3 AND c.user_filename=$4 LIMIT 2`,
                    [path.slice("attachments/".length), stage[1], stage[3], stage[4]],
                );
                return unique(staged, "upload");
            }
            const match = /^attachments\/(\d+)\/(\d+)\/([^/]+)$/.exec(path);
            if (!match) return unknown();
            const posted = await this.database.query(
                `SELECT DISTINCT CASE
                WHEN m.webhook_id IS NOT NULL THEN CASE WHEN w.id IS NOT NULL THEN 'webhook:' || CAST(w.id AS text) ELSE NULL END
                WHEN m.application_id IS NOT NULL THEN CASE WHEN app.id IS NOT NULL THEN 'application:' || CAST(app.id AS text) ELSE NULL END
                WHEN u.id IS NOT NULL THEN 'user:' || CAST(u.id AS text) ELSE NULL END AS principal
                FROM attachments a JOIN messages m ON m.id=a.message_id AND m.channel_id=$1
                LEFT JOIN users u ON u.id=m.author_id LEFT JOIN webhooks w ON w.id=m.webhook_id LEFT JOIN applications app ON app.id=m.application_id
                WHERE (a.channel_id=$1 OR a.channel_id IS NULL) AND (a.id=$2 OR a.message_id=$2) AND a.filename=$3 LIMIT 3`,
                [match[1], match[2], match[3]],
            );
            return unique(posted, "upload");
        }
        const image = /^(avatars|banners)\/(\d+)\/([^/]+)$/.exec(path);
        if (image) {
            const column = image[1] === "avatars" ? "avatar" : "banner";
            const rows = await this.database.query(`SELECT 'user:' || CAST(id AS text) AS principal FROM users WHERE id=$1 AND ${column}=$2`, [image[2], image[3]]);
            if (image[1] === "avatars")
                rows.push(...(await this.database.query(`SELECT 'webhook:' || CAST(id AS text) AS principal FROM webhooks WHERE id=$1 AND avatar=$2`, [image[2], image[3]])));
            return unique(rows, "managed");
        }
        const member = /^guilds\/(\d+)\/users\/(\d+)\/(avatars|banners)\/([^/]+)$/.exec(path);
        if (member) {
            const column = member[3] === "avatars" ? "avatar" : "banner";
            return unique(
                await this.database.query(
                    `SELECT 'user:' || CAST(m.id AS text) AS principal FROM members m JOIN users u ON u.id=m.id WHERE m.guild_id=$1 AND m.id=$2 AND m.${column}=$3`,
                    [member[1], member[2], member[4]],
                ),
                "managed",
            );
        }
        const application = /^app-icons\/(\d+)\/([^/]+)$/.exec(path);
        if (application)
            return unique(
                await this.database.query(`SELECT 'application:' || CAST(id AS text) AS principal FROM applications WHERE id=$1 AND (icon=$2 OR cover_image=$2)`, [
                    application[1],
                    application[2],
                ]),
                "managed",
            );
        return unknown();
    }
    async persistedPrincipal(principal: string): Promise<boolean> {
        const match = /^(user|webhook|application):(\d+)$/.exec(principal);
        if (!match) return false;
        const table = { user: "users", webhook: "webhooks", application: "applications" }[match[1] as "user" | "webhook" | "application"];
        return (await this.database.query(`SELECT '${match[1]}:' || CAST(id AS text) AS principal FROM ${table} WHERE id=$1`, [match[2]])).some(
            (row) => row.principal === principal,
        );
    }
}
