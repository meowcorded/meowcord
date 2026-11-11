import { createHash } from "node:crypto";
import { finished, pipeline } from "node:stream/promises";
import { admitDownload, admitPreview, inspectDownload } from "../util/downloadAdmission";
import { Request, Response, Router, raw, NextFunction } from "express";
import multerConfig from "multer";
import { fileTypeFromBuffer } from "file-type";
import imageSize from "image-size";
import { HTTPError } from "lambert-server/HTTPError";
import { Attachment, CloudAttachment, getDatabase } from "@spacebar/database";
import {
    Config,
    extractVideoFrame,
    hasValidSignature,
    readVideoDimensions,
    reserveVideoFrame,
    NewUrlUserSignatureData,
    Snowflake,
    UrlSignResult,
    isRequestSignature,
} from "@spacebar/util";
import { storage, multer, setCacheControl, safeMediaType } from "../util";
import { InternalCdnAttachment } from "@spacebar/util/dtos/MessageOptions";
import { cleanAttachmentFilename } from "@spacebar/util/util/AttachmentFilename";

import { declaredCloudUploadLimit, requireCloudUploadReservation, requireInternalUploadSignature } from "../util/cloudUploads";
import { bufferedUpload, internalUploadBufferLimit, internalUploadBufferOverhead } from "../util/uploadAdmission";

const router = Router({ mergeParams: true });

const slotWrites = new Map<string, Promise<void>>();

const SANITIZED_CONTENT_TYPE = ["text/html", "text/mhtml", "multipart/related", "application/xhtml+xml"];

router.post(
    "/:channel_id/:message_id",
    requireInternalUploadSignature,
    bufferedUpload(
        internalUploadBufferLimit,
        multer.single("file"),
        async (req: Request, res: Response) => {
            if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");

            if (!req.file) throw new HTTPError("file missing");

            const { buffer, mimetype, size, originalname } = req.file;
            const { channel_id, message_id } = req.params as { [key: string]: string };
            const filename = cleanAttachmentFilename(originalname);
            const attachment_id = Snowflake.generate();
            const path = `attachments/${channel_id}/${attachment_id}/${filename}`;

            const endpoint = Config.get()?.cdn.endpointPublic?.replace(/\/+$/, "");

            await storage.set(path, buffer);
            let width;
            let height;
            if (mimetype.includes("image")) {
                try {
                    const dimensions = imageSize(buffer);
                    if (dimensions) {
                        width = dimensions.width;
                        height = dimensions.height;
                    }
                } catch (e) {
                    console.warn("Failed to get image size for attachment of type", mimetype, "because of", e);
                }
            }

            const finalUrl = `${endpoint}/${path}`;

            const file: InternalCdnAttachment = {
                id: attachment_id,
                channel_id,
                message_id,
                content_type: mimetype,
                filename: filename,
                size,
                url: finalUrl,
                path,
                width,
                height,
            };

            return res.json(file);
        },
        internalUploadBufferOverhead,
    ),
);

router.get("/:channel_id/:attachment_id/:filename", setCacheControl, async (req: Request, res: Response) => {
    const { channel_id, attachment_id, filename } = req.params as { [key: string]: string };
    // const { format } = req.query;
    if (!/^\d+$/.test(channel_id) || !/^\d+$/.test(attachment_id)) throw new HTTPError("File not found", 404);

    const path = `attachments/${channel_id}/${attachment_id}/${filename}`;

    const fullUrl = (req.headers["x-forwarded-proto"] ?? req.protocol) + "://" + (req.headers["x-forwarded-host"] ?? req.hostname) + req.originalUrl;

    let hasValidAuth = false;
    if (req.headers.signature) {
        hasValidAuth = isRequestSignature(req.headers.signature);
        if (!hasValidAuth) console.warn("[CDN/Attachments] Client sent invalid signature header");
    } else if (!Config.get().security.cdnSignUrls) {
        hasValidAuth = true;
    } else {
        hasValidAuth = hasValidSignature(
            new NewUrlUserSignatureData({
                ip: req.ip,
                userAgent: req.headers["user-agent"] as string,
            }),
            UrlSignResult.fromUrl(fullUrl),
        );
        if (!hasValidAuth) console.warn("[CDN/Attachments] Client sent invalid attachment URL signature");
    }

    if (!hasValidAuth) return res.status(404).send("This content is no longer available.");

    const release = admitDownload();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    timer.unref();
    const abort = () => {
        if (!res.writableEnded) controller.abort();
    };
    res.once("close", abort);
    let file;
    try {
        if (!storage.openRead) throw new HTTPError("Streaming storage unavailable", 503);
        file = await storage.openRead(path, controller.signal);
        if (!file) {
            const att = await Attachment.findOne({ where: { channel_id, id: attachment_id } });
            if (att?.filename === filename) {
                const attPath = `attachments/${channel_id}/${att.message_id}/${filename}`;
                if (await storage.exists(attPath)) await storage.move(attPath, path).catch(() => undefined);
                file = await storage.openRead(path, controller.signal);
            }
        }
        if (!file) throw new HTTPError("File not found", 404);
        if (controller.signal.aborted) throw new HTTPError("Download aborted", 408);
        const inspected = await inspectDownload(file.stream, file.size);
        const type = await fileTypeFromBuffer(inspected.prefix);
        if (req.query.format && type?.mime.startsWith("video/")) {
            const releasePreview = admitPreview(file.size);
            const releaseFrame = reserveVideoFrame();
            try {
                if (!releaseFrame) {
                    res.set("Retry-After", "1");
                    res.status(503).send("Preview capacity is busy");
                    await finished(res);
                    return;
                }
                const chunks: Buffer[] = [];
                for await (const chunk of inspected.stream) chunks.push(Buffer.from(chunk));
                const frame = await extractVideoFrame(Buffer.concat(chunks, file.size), undefined, true);
                if (!frame) {
                    res.status(415).send("Unable to render a preview frame");
                    await finished(res);
                    return;
                }
                res.set("Content-Type", "image/jpeg");
                res.send(frame);
                await finished(res);
                return;
            } finally {
                releaseFrame?.();
                releasePreview();
            }
        }
        if (type) res.set("Content-Type", safeMediaType(type.mime));
        else {
            res.type(filename);
            const guessed = String(res.get("Content-Type"));
            if (SANITIZED_CONTENT_TYPE.some((x) => guessed.startsWith(x)) || /^(text\/(javascript|xml)|image\/svg)/.test(guessed))
                res.set("Content-Type", "text/plain; charset=utf-8");
            else if (!guessed.startsWith("text/") && !guessed.startsWith("application/json")) res.set("Content-Type", "application/octet-stream");
        }

        res.set("Content-Length", String(file.size));
        if (req.method === "HEAD") {
            res.end();
            await finished(res);
            return;
        }
        await pipeline(inspected.stream, res, { signal: controller.signal });
    } catch (error) {
        if (!res.headersSent && !res.destroyed) throw error;
        if (!res.writableFinished) res.destroy();
    } finally {
        clearTimeout(timer);
        res.removeListener("close", abort);
        if (file) {
            const closed = finished(file.stream).catch(() => undefined);
            file.stream.destroy();
            await closed;
        }
        release();
    }
});

router.delete("/:channel_id/:attachment_id/:filename", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");

    const { channel_id, attachment_id, filename } = req.params as { [key: string]: string };
    const path = `attachments/${channel_id}/${attachment_id}/${filename}`;

    await storage.delete(path);

    return res.send({ success: true });
});

function parseCloudUpload(req: Request, res: Response, next: NextFunction) {
    const limit = declaredCloudUploadLimit(res.locals.cloudAttachment);
    const parser = req.is("multipart/form-data")
        ? multerConfig({
              storage: multerConfig.memoryStorage(),
              limits: {
                  fileSize: limit,
                  files: 1,
                  fields: 10,
                  fieldSize: 1024,
                  parts: 11,
                  headerPairs: 64,
              },
          }).single("file")
        : raw({ type: () => true, limit, inflate: false });
    parser(req, res, (error) => {
        if (error instanceof multerConfig.MulterError && error.code === "LIMIT_FILE_SIZE") return next(new HTTPError("File too large", 413));
        return next(error);
    });
}

router.put(
    "/:channel_id/:batch_id/:attachment_id/:filename",
    requireCloudUploadReservation,
    bufferedUpload(
        (_req, res) => declaredCloudUploadLimit(res.locals.cloudAttachment),
        parseCloudUpload,
        async (req: Request, res: Response) => {
            const { channel_id, batch_id, attachment_id, filename } = req.params as {
                [key: string]: string;
            };
            const buffer = req.file?.buffer ?? req.body ?? (res.locals.cloudAttachment.userFileSize === 0 ? Buffer.alloc(0) : undefined);
            if (!Buffer.isBuffer(buffer)) throw new HTTPError("file missing", 400);
            if (buffer.length > Config.get().cdn.maxAttachmentSize) throw new HTTPError("File too large", 413);

            const where = {
                uploadFilename: `${channel_id}/${batch_id}/${attachment_id}/${filename}`,
                channelId: channel_id,
                userAttachmentId: attachment_id,
                userFilename: filename,
            };
            const path = `attachments/${channel_id}/${batch_id}/${attachment_id}/${filename}`;
            const write = (slotWrites.get(path) ?? Promise.resolve())
                .catch(() => undefined)
                .then(async () => {
                    const att = await CloudAttachment.findOne({ where });
                    if (!att?.userId) throw new HTTPError("Attachment not found", 404);
                    if (buffer.length > declaredCloudUploadLimit(att)) throw new HTTPError("File too large", 413);

                    let mimeType = att.userOriginalContentType;
                    if (mimeType === null) {
                        const ft = await fileTypeFromBuffer(buffer);
                        mimeType = att.contentType = ft?.mime || "application/octet-stream";
                    }

                    try {
                        const dimensions = mimeType?.includes("image") ? imageSize(buffer) : mimeType?.startsWith("video/") ? readVideoDimensions(buffer) : undefined;
                        if (dimensions) {
                            att.width = dimensions.width;
                            att.height = dimensions.height;
                        }
                    } catch {
                        att.width = undefined;
                        att.height = undefined;
                    }

                    await storage.set(path, buffer, `user:${att.userId}`);
                    const kept = await getDatabase()!.transaction(async (manager) => {
                        const current = await manager.getRepository(CloudAttachment).findOne({ lock: { mode: "pessimistic_write" }, where: { ...where, id: att.id } });
                        if (!current) return false;
                        current.contentType = att.contentType;
                        current.width = att.width;
                        current.height = att.height;
                        current.size = buffer.length;
                        current.contentHash = createHash("sha256").update(buffer).digest("hex");
                        await manager.save(current);
                        return true;
                    });
                    if (kept) return;
                    await storage.delete(path);
                    throw new HTTPError("Attachment not found", 404);
                });
            slotWrites.set(path, write);
            try {
                await write;
            } finally {
                if (slotWrites.get(path) === write) slotWrites.delete(path);
            }
            return res.status(200).end();
        },
    ),
);

router.delete("/:channel_id/:batch_id/:attachment_id/:filename", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");

    const { channel_id, batch_id, attachment_id, filename } = req.params as {
        [key: string]: string;
    };
    const path = `attachments/${channel_id}/${batch_id}/${attachment_id}/${filename}`;

    const att = await CloudAttachment.findOne({
        where: {
            uploadFilename: `${channel_id}/${batch_id}/${attachment_id}/${filename}`,
            channelId: channel_id,
            userAttachmentId: attachment_id,
            userFilename: filename,
        },
    });

    if (att) {
        await storage.delete(path);
        await att.remove();
        await storage.delete(path);
        return res.send({ success: true });
    }
    return res.status(404).send("Attachment not found");
});

router.post("/:channel_id/:batch_id/:attachment_id/:filename/clone_to_message/:message_id", async (req: Request, res: Response) => {
    if (!isRequestSignature(req.headers.signature)) throw new HTTPError("Invalid request signature");

    const { channel_id, batch_id, attachment_id, filename, message_id } = req.params as {
        [key: string]: string;
    };
    const target = typeof req.query.channel_id === "string" && /^\d+$/.test(req.query.channel_id) ? req.query.channel_id : channel_id;
    const path = `attachments/${channel_id}/${batch_id}/${attachment_id}/${filename}`;
    const destination = typeof req.query.attachment_id === "string" && /^\d+$/.test(req.query.attachment_id) ? req.query.attachment_id : message_id;
    const newPath = `attachments/${target}/${destination}/${filename}`;

    const att = await CloudAttachment.findOne({
        where: {
            uploadFilename: `${channel_id}/${batch_id}/${attachment_id}/${filename}`,
            channelId: channel_id,
            userAttachmentId: attachment_id,
            userFilename: filename,
        },
    });

    if (att) {
        await storage.clone(path, newPath);
        return res.send({ success: true, new_path: newPath });
    }

    return res.status(404).send("Attachment not found");
});

export default router;
