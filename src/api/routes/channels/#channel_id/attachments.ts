import { sqlGreatest } from "@spacebar/database/Sql";
import { Request, Response, Router } from "express";
import { route } from "@spacebar/api/middlewares";
import { Channel, CloudAttachment, User, getDatabase } from "@spacebar/database";
import { Random } from "@spacebar/extensions";
import { Config, Permissions, getPermission } from "@spacebar/util";
import { HTTPError } from "lambert-server/HTTPError";
import { UploadAttachmentRequestSchema, UploadAttachmentResponseSchema } from "@spacebar/schemas";

const router: Router = Router({ mergeParams: true });

router.post(
    "/",
    route({
        requestBody: "UploadAttachmentRequestSchema",
        responses: {
            200: {
                body: "UploadAttachmentResponseSchema",
            },
            404: {},
            403: {},
            429: {},
            400: {
                body: "APIErrorResponse",
            },
        },
    }),
    async (req: Request, res: Response) => {
        const payload = req.body as UploadAttachmentRequestSchema;
        const { channel_id } = req.params as { [key: string]: string };

        const user = req.user;
        const channel = await Channel.findOneOrFail({ where: { id: channel_id } });

        const permission = await getPermission(req.user_id, channel.guild_id, channel.id);
        if (!permission.has(Permissions.FLAGS.ATTACH_FILES) || !permission.has(Permissions.FLAGS.VIEW_CHANNEL)) {
            return res.status(403).json({
                code: 403,
                message: "Missing Permissions: ATTACH_FILES",
            });
        }

        const cdnUrl = Config.get().cdn.endpointPublic?.replace(/\/+$/, "");
        const batchId = `CLOUD_${user.id}_${Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 128)}`;

        const maxAttachmentSize = Config.get().cdn.maxAttachmentSize;
        const batchLimit = Math.min(100, Config.get().limits.message.maxAttachments);
        if (!Number.isSafeInteger(maxAttachmentSize) || maxAttachmentSize < 1 || !Number.isSafeInteger(batchLimit) || batchLimit < 1)
            throw new HTTPError("Uploads are unavailable", 503);
        if (!payload.files.length || payload.files.length > batchLimit) throw new HTTPError("Too many attachments in one upload request", 400);
        const seenIds: (string | undefined)[] = [];
        for (const file of payload.files) {
            if (seenIds.includes(file.id)) {
                return res.status(400).json({
                    code: 400,
                    message: `Duplicate attachment ID: ${file.id}`,
                });
            }
            if (file.id !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(file.id)) throw new HTTPError("Invalid attachment ID", 400);
            seenIds.push(file.id);
            file.filename = file.filename.replaceAll(" ", "_").replace(/[^a-zA-Z0-9._-]+/g, "");
            if (!file.filename || file.filename === "." || file.filename === ".." || file.filename.length > 255) throw new HTTPError("Invalid attachment filename", 400);
            if (!Number.isSafeInteger(file.file_size) || file.file_size < 0 || file.file_size > maxAttachmentSize) {
                return res.status(400).json({
                    code: 40005,
                    message: "Request entity too large",
                });
            }
        }

        const attachments = await getDatabase()!.transaction(async (manager) => {
            await manager.getRepository(User).createQueryBuilder("user").select("user.id").where("user.id = :id", { id: user.id }).setLock("pessimistic_write").getOneOrFail();
            const pending = await manager
                .getRepository(CloudAttachment)
                .createQueryBuilder("attachment")
                .select("COUNT(*)", "count")
                .addSelect(`COALESCE(SUM(${sqlGreatest("COALESCE(attachment.user_file_size, 0)", "COALESCE(attachment.size, 0)", "0")}), 0)`, "bytes")
                .addSelect("COALESCE(SUM(CASE WHEN attachment.size IS NULL THEN 1 ELSE 0 END), 0)", "pending_count")
                .addSelect(`COALESCE(SUM(CASE WHEN attachment.size IS NULL THEN ${sqlGreatest("COALESCE(attachment.user_file_size, 0)", "0")} ELSE 0 END), 0)`, "pending_bytes")
                .where("attachment.user_id = :id", { id: user.id })
                .getRawOne<{
                    count: string;
                    bytes: string;
                    pending_count: string;
                    pending_bytes: string;
                }>();
            const pendingBytes = payload.files.reduce((total, file) => total + file.file_size, 0);
            const byteLimit = Math.max(maxAttachmentSize, 1024 * 1024 * 1024);
            if (
                !pending ||
                Number(pending.pending_count) + payload.files.length > 32 ||
                Number(pending.pending_bytes) + pendingBytes > byteLimit ||
                Number(pending.count) + payload.files.length > 512 ||
                Number(pending.bytes) + pendingBytes > Math.max(maxAttachmentSize, 2 * 1024 * 1024 * 1024)
            )
                throw new HTTPError("Too many pending uploads. Finish or cancel an upload first.", 429);
            const newAttachments = payload.files.map((attachment) =>
                CloudAttachment.create({
                    userId: user.id,
                    channelId: channel.id,
                    uploadFilename: `${channel_id}/${batchId}/${attachment.id ?? "0"}/${attachment.filename}`,
                    userAttachmentId: attachment.id ?? "0",
                    userFilename: attachment.filename,
                    userFileSize: attachment.file_size,
                    userIsClip: attachment.is_clip,
                    userOriginalContentType: attachment.original_content_type,
                }),
            );
            return manager.save(newAttachments);
        });

        res.send({
            attachments: attachments.map((a) => ({
                id: a.userAttachmentId,
                upload_filename: a.uploadFilename,
                upload_url: `${cdnUrl}/attachments/${a.uploadFilename}`,
                original_content_type: a.userOriginalContentType,
            })),
        } as UploadAttachmentResponseSchema);
    },
);

router.delete("/:cloud_attachment_url", route({}), async (req: Request, res: Response) => {
    const { channel_id, cloud_attachment_url } = req.params as { [key: string]: string };

    const user = req.user;
    const channel = await Channel.findOneOrFail({ where: { id: channel_id } });
    const att = await CloudAttachment.findOneOrFail({
        where: { uploadFilename: decodeURI(cloud_attachment_url) },
    });
    if (att.userId !== user.id) {
        return res.status(403).json({
            code: 403,
            message: "You do not own this attachment.",
        });
    }

    if (att.channelId !== channel.id) {
        return res.status(400).json({
            code: 400,
            message: "Attachment does not belong to this channel.",
        });
    }

    const response = await fetch(`${Config.get().cdn.endpointPrivate}/attachments/${att.uploadFilename}`, {
        headers: {
            signature: Config.get().security.requestSignature,
        },
        method: "DELETE",
    });

    await att.remove();
    return res.status(response.status).send(response.body);
});

export default router;
