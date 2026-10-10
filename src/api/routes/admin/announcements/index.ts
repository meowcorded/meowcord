import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import multer from "multer";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Announcement, getDatabase, User } from "@spacebar/database";
import { Config, Snowflake } from "@spacebar/util";
import { AdminAnnouncementCreateSchema } from "@spacebar/schemas";
import { getSystemAccount, serializeOfficial } from "@spacebar/api/util";
import {
    ANNOUNCEMENT_MAX_BYTES,
    announcementCounts,
    removeAnnouncementSpool,
    runAnnouncementDeliveries,
    writeAnnouncementSpool,
} from "@spacebar/api/util/utility/announcementDelivery";

const router = Router({ mergeParams: true });
const STAFF_RIGHTS_MASK = 1 + 4 + 128;

router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Recent staff announcements and durable delivery counts",
    }),
    async (req: Request, res: Response) => {
        const official = await getSystemAccount("official");
        const announcements = await Announcement.find({ order: { created_at: "DESC" }, take: 50 });
        const counts = await announcementCounts(announcements.map((announcement) => announcement.id));
        res.json({
            official: serializeOfficial(official),
            announcements: announcements.map((announcement) => ({
                ...announcement,
                delivery: announcement.durable ? counts[announcement.id] : null,
            })),
            limits: { total_attachment_bytes: ANNOUNCEMENT_MAX_BYTES, max_selected_recipients: 100 },
        });
    },
);

const uploadBytes = new WeakMap<Request, number>();
const boundedStorage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
        const chunks: Buffer[] = [];
        let size = 0;
        let completed = false;
        file.stream.on("data", (chunk: Buffer) => {
            if (completed) return;
            const total = (uploadBytes.get(req) ?? 0) + chunk.length;
            uploadBytes.set(req, total);
            if (total > ANNOUNCEMENT_MAX_BYTES) {
                completed = true;
                chunks.length = 0;
                callback(new multer.MulterError("LIMIT_FILE_SIZE", file.fieldname));
                return;
            }
            chunks.push(chunk);
            size += chunk.length;
        });
        file.stream.once("error", (error) => {
            if (!completed) {
                completed = true;
                callback(error);
            }
        });
        file.stream.once("end", () => {
            if (!completed) {
                completed = true;
                callback(null, { buffer: Buffer.concat(chunks), size });
            }
        });
    },
    _removeFile(req, file, callback) {
        delete (file as Partial<Express.Multer.File>).buffer;
        callback(null);
    },
};
const announcementUpload = multer({
    limits: {
        fileSize: Math.min(ANNOUNCEMENT_MAX_BYTES, Config.get().limits.message.maxAttachmentSize),
        fields: 10,
        files: Math.min(10, Config.get().limits.message.maxAttachments),
    },
    storage: boundedStorage,
});
let activeUploads = 0;
router.post(
    "/",
    route({ right: "OPERATOR", spacebarOnly: true }),
    (req, res, next) => {
        if (activeUploads >= 2) {
            res.setHeader("Retry-After", "5");
            return res.status(503).json({ message: "Announcement upload busy; try again shortly" });
        }
        activeUploads++;
        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                activeUploads--;
            }
        };
        res.once("close", release);
        res.once("finish", release);
        announcementUpload.any()(req, res, next);
    },
    (req, res, next) => {
        try {
            if (req.body.payload_json) req.body = JSON.parse(req.body.payload_json);
            next();
        } catch {
            next(new HTTPError("Invalid announcement payload", 400));
        }
    },
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        requestBody: "AdminAnnouncementCreateSchema",
        description: "Queue an encrypted announcement from the official account; recipients without encryption keys wait until ready",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminAnnouncementCreateSchema;
        const files = (req.files as Express.Multer.File[]) ?? [];
        const content = body.body.trim();
        if (!content || content.length > Config.get().limits.message.maxCharacters) throw new HTTPError("Announcement text exceeds the message limit or is empty", 400);
        if (files.reduce((sum, file) => sum + file.buffer.length, 0) > ANNOUNCEMENT_MAX_BYTES) throw new HTTPError("Attachments exceed the combined 10 MiB limit", 400);
        const selected = body.recipient_ids;
        if (
            body.audience === "selected" &&
            (!selected?.length ||
                selected.length > 100 ||
                new Set(selected).size !== selected.length ||
                selected.some((id) => !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n))
        )
            throw new HTTPError("Selected recipients must be 1–100 unique numeric user IDs", 400);
        if (body.audience !== "selected" && selected !== undefined) throw new HTTPError("Recipient IDs require the selected audience", 400);
        if (body.audience === "selected") {
            const count = await User.createQueryBuilder("u")
                .where("u.id IN (:...ids)", { ids: selected })
                .andWhere("u.deleted=false AND u.bot=false AND u.system=false")
                .getCount();
            if (count !== selected!.length) throw new HTTPError("One or more selected recipients are unavailable", 400);
        }
        const id = Snowflake.generate();
        await writeAnnouncementSpool(id, files);
        const database = getDatabase();
        if (!database) {
            await removeAnnouncementSpool(id);
            throw new HTTPError("Database unavailable", 503);
        }
        let announcement: Announcement;
        try {
            announcement = await database.transaction(async (manager) => {
                const entity = await manager.getRepository(Announcement).save({
                    id,
                    body: content,
                    audience: body.audience,
                    sent_by: req.user_id,
                    durable: true,
                    attachment_count: files.length,
                    recipient_count: 0,
                });
                const filter = body.audience === "staff" ? `AND (u.rights & CAST($2 AS bigint)) != 0` : body.audience === "selected" ? `AND ${sqlArrayIncludes("u.id", "$2")}` : "";
                const args = body.audience === "everyone" ? [id] : [id, body.audience === "staff" ? STAFF_RIGHTS_MASK : selected];
                const queued = await manager.query(
                    `INSERT INTO announcement_deliveries (announcement_id,user_id)
                    SELECT $1,u.id FROM users u WHERE u.deleted=false AND u.bot=false AND u.system=false ${filter} RETURNING user_id`,
                    args,
                );
                entity.recipient_count = queued.length;
                await manager.getRepository(Announcement).update({ id }, { recipient_count: queued.length });
                return entity;
            });
        } catch (error) {
            await removeAnnouncementSpool(id);
            throw error;
        }
        res.status(201).json({
            ...announcement,
            delivery: { queued: announcement.recipient_count, delivering: 0, delivered: 0, failed: 0 },
        });
        void runAnnouncementDeliveries().catch(() => console.error("[Announcement] Delivery deferred; durable queue retained"));
    },
);
export default router;
