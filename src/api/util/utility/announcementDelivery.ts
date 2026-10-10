import { sqlArrayIncludes, sqlNow, sqlReturning } from "@spacebar/database/Sql";
import { constants, promises as fs } from "node:fs";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Announcement, AnnouncementDelivery, AnnouncementMessage, getDatabase, User } from "@spacebar/database";
import { Snowflake } from "@spacebar/util";
import { EncryptedSystemFile, encryptSystemFiles, openSystemSpool, sealSystemSpool, SystemRecipientNotReady } from "./systemEncryption";
import { getSystemAccount, sendSystemDM } from "./systemAccounts";
import { deleteAnnouncementMessages } from "./announcements";

export const ANNOUNCEMENT_MAX_BYTES = 10 * 1024 * 1024;
const spoolDirectory = () => process.env.ANNOUNCEMENT_SPOOL_DIR || path.join(path.dirname(path.resolve(process.env.CONFIG_PATH || "config.json")), ".announcement-spool");
const spoolPath = (id: string) => {
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid announcement identifier");
    return path.join(spoolDirectory(), `${id}.bin`);
};
export async function writeAnnouncementSpool(id: string, files: Express.Multer.File[]) {
    if (!files.length) return;
    if (files.reduce((sum, file) => sum + file.buffer.length, 0) > ANNOUNCEMENT_MAX_BYTES) throw new Error("Announcement attachments exceed the combined 10 MiB limit");
    await fs.mkdir(spoolDirectory(), { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(spoolDirectory());
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error("Announcement spool must be a private directory");
    const encrypted = encryptSystemFiles(files);
    const payload = JSON.stringify(encrypted.map((file) => ({ ...file, buffer: file.buffer.toString("base64") })));
    const sealed = await sealSystemSpool(await getSystemAccount("official"), id, payload);
    const filename = spoolPath(id);
    const temporary = `${filename}.${randomBytes(12).toString("hex")}.tmp`;
    try {
        const file = await fs.open(temporary, "wx", 0o600);
        try {
            await file.writeFile(sealed);
            await file.sync();
        } finally {
            await file.close();
        }
        await fs.rename(temporary, filename);
        const directory = await fs.open(spoolDirectory(), constants.O_RDONLY);
        try {
            await directory.sync();
        } finally {
            await directory.close();
        }
    } finally {
        await fs.unlink(temporary).catch(() => undefined);
    }
}
export const removeAnnouncementSpool = (id: string) =>
    fs.unlink(spoolPath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
async function readAnnouncementSpool(id: string, expected: number): Promise<EncryptedSystemFile[]> {
    let file;
    try {
        file = await fs.open(spoolPath(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !expected) return [];
        throw error;
    }
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > ANNOUNCEMENT_MAX_BYTES * 2) throw new Error("Invalid announcement spool");
        const payload = await openSystemSpool(await getSystemAccount("official"), id, await file.readFile());
        return JSON.parse(payload).map((value: EncryptedSystemFile & { buffer: string }) => ({
            ...value,
            buffer: Buffer.from(value.buffer, "base64"),
        }));
    } finally {
        await file.close();
    }
}
export async function announcementCounts(ids: string[]) {
    if (!ids.length) return {};
    const db = getDatabase();
    if (!db) throw new Error("Database unavailable");
    const rows = await db.query(
        `SELECT announcement_id, status, CAST(count(*) AS integer) AS count FROM announcement_deliveries WHERE ${sqlArrayIncludes("announcement_id", "$1")} GROUP BY announcement_id,status`,
        [ids],
    );
    const counts: Record<string, { queued: number; delivering: number; delivered: number; failed: number }> = {};
    for (const id of ids) counts[id] = { queued: 0, delivering: 0, delivered: 0, failed: 0 };
    for (const row of rows) counts[row.announcement_id][row.status as "queued"] = row.count;
    return counts;
}
export async function deliverAnnouncement(delivery: AnnouncementDelivery) {
    const database = getDatabase();
    if (!database) return;
    const token = randomUUID();
    const [claimed] = await database.query(
        sqlReturning(`UPDATE announcement_deliveries SET status='delivering', attempts=attempts+1,
        message_id=COALESCE(message_id,CAST($3 AS bigint)), lease_token=$4, next_retry_at=$5
        WHERE announcement_id=$1 AND user_id=$2 AND status IN ('queued','delivering') AND next_retry_at<=${sqlNow()} RETURNING *`),
        [delivery.announcement_id, delivery.user_id, Snowflake.generate(), token, new Date(Date.now() + 600_000)],
    );
    if (!claimed) return;
    const where = {
        announcement_id: claimed.announcement_id,
        user_id: claimed.user_id,
        lease_token: token,
    };
    const heartbeat = setInterval(() => {
        void AnnouncementDelivery.update(where, {
            next_retry_at: new Date(Date.now() + 600_000),
        }).catch(() => undefined);
    }, 30_000);
    heartbeat.unref();
    try {
        const announcement = await Announcement.findOne({ where: { id: claimed.announcement_id } });
        if (!announcement?.durable) return;
        const user = await User.findOne({
            where: { id: claimed.user_id, deleted: false, bot: false, system: false },
        });
        if (!user) {
            await AnnouncementDelivery.update(where, {
                status: "failed",
                last_error: "recipient_unavailable",
                lease_token: null,
            });
            return;
        }
        const message = await sendSystemDM("official", user.id, {
            id: claimed.message_id,
            content: announcement.body,
            encryptedFiles: await readAnnouncementSpool(announcement.id, announcement.attachment_count),
        });
        try {
            await database.transaction(async (manager) => {
                const present = await manager.getRepository(Announcement).findOne({ where: { id: announcement.id }, lock: { mode: "pessimistic_read" } });
                if (!present) throw new Error("Announcement deleted");
                await manager.getRepository(AnnouncementMessage).upsert(
                    {
                        announcement_id: announcement.id,
                        message_id: message.id,
                        channel_id: message.channel_id!,
                    },
                    ["message_id"],
                );
                await manager.getRepository(AnnouncementDelivery).update(where, { status: "delivered", last_error: null, lease_token: null });
            });
        } catch (error) {
            await deleteAnnouncementMessages([{ id: message.id, channel_id: message.channel_id }]);
            throw error;
        }
    } catch (error) {
        const preparing = error instanceof SystemRecipientNotReady;
        const retry = preparing || claimed.attempts < 10;
        await AnnouncementDelivery.update(where, {
            status: retry ? "queued" : "failed",
            lease_token: null,
            last_error: preparing ? "encryption_not_ready" : "delivery_error",
            next_retry_at: new Date(Date.now() + (preparing ? 30_000 : Math.min(300_000, 5_000 * 2 ** Math.min(claimed.attempts - 1, 6)))),
        });
    } finally {
        clearInterval(heartbeat);
    }
}
let running: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;
export function runAnnouncementDeliveries() {
    if (running) return running;
    if (stopping) return Promise.resolve();
    running = (async () => {
        const database = getDatabase();
        if (!database) return;
        const rows: AnnouncementDelivery[] = await database.query(`SELECT d.* FROM announcement_deliveries d JOIN announcements a ON a.id=d.announcement_id
            WHERE a.durable=true AND d.status IN ('queued','delivering') AND d.next_retry_at <= ${sqlNow()} ORDER BY d.next_retry_at,d.announcement_id,d.user_id LIMIT 16`);
        for (let index = 0; index < rows.length; index += 4) {
            if (stopping) break;
            await Promise.allSettled(rows.slice(index, index + 4).map(deliverAnnouncement));
        }
    })().finally(() => {
        running = undefined;
    });
    return running;
}
export function startAnnouncementDeliveryWorker() {
    if (timer || stopping) return;
    const run = () => void runAnnouncementDeliveries().catch(() => console.error("[Announcement] Delivery worker unavailable; durable queue retained"));
    timer = setInterval(run, 5_000).unref();
    ProcessLifecycle.eventEmitter.once("stopping", async () => {
        stopping = true;
        clearInterval(timer);
        await Promise.allSettled(running ? [running] : []);
    });
    run();
}
