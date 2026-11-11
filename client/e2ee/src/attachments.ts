import { attachmentCiphertextUrl } from "./attachmentUrl";
import { Bytes, randomBytes, toB64u } from "./bytes";
import { RawMessage } from "./engine";
import { encryptedSize, encryptFile, FILE_PREFIX, FileEntry, FileMeta, Payload, SW_PATH } from "./files";

const CONTROL_TIMEOUT_MS = 8000;
const SPOILER_FLAG = 1 << 3;

interface Upload {
    name: string;
    filename: string;
    content_type: string;
    size: number;
    key: Bytes;
    iv: Bytes;
    encrypted: Promise<Blob> | null;
    uploaded: boolean;
    width?: number;
    height?: number;
    duration_secs?: number;
}

export interface UploadRef {
    id?: string | number;
    filename?: string;
    uploaded_filename?: string;
    description?: string;
    is_spoiler?: boolean;
    duration_secs?: number;
    waveform?: string;
}

interface CreatedAttachment {
    id: string | number;
    upload_url: string;
    upload_filename: string;
}

const describe = async (file: Blob, type: string): Promise<Partial<Upload>> => {
    if (type.startsWith("image/"))
        try {
            const bitmap = await createImageBitmap(file);
            const size = { width: bitmap.width, height: bitmap.height };
            bitmap.close();
            return size;
        } catch {
            return {};
        }
    if (!type.startsWith("video/") && !type.startsWith("audio/")) return {};
    return new Promise((resolve) => {
        const media = document.createElement(type.startsWith("video/") ? "video" : "audio");
        const src = URL.createObjectURL(file);
        const done = (value: Partial<Upload>) => {
            clearTimeout(timer);
            media.onloadedmetadata = null;
            media.onerror = null;
            media.pause();
            media.removeAttribute("src");
            media.load();
            media.remove();
            URL.revokeObjectURL(src);
            resolve(value);
        };
        const timer = setTimeout(() => done({}), 5000);
        media.preload = "metadata";
        media.muted = true;
        media.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
        media.onloadedmetadata = () => {
            const video = media instanceof HTMLVideoElement && media.videoWidth ? { width: media.videoWidth, height: media.videoHeight } : {};
            done({
                ...video,
                ...(Number.isFinite(media.duration) ? { duration_secs: media.duration } : {}),
            });
        };
        media.onerror = () => done({});
        document.body.append(media);
        media.src = src;
        media.load();
    });
};

const POSTER_WIDTH = 1280;

const renderPoster = (blob: Blob, type: string) =>
    new Promise<Blob | null>((resolve) => {
        const video = document.createElement("video");
        const src = URL.createObjectURL(new Blob([blob], { type }));
        const done = (image: Blob | null) => {
            clearTimeout(timer);
            video.onloadeddata = null;
            video.onerror = null;
            video.pause();
            video.removeAttribute("src");
            video.load();
            video.remove();
            URL.revokeObjectURL(src);
            resolve(image);
        };
        const timer = setTimeout(() => done(null), 10000);
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        video.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
        video.onloadeddata = () => {
            try {
                const scale = Math.min(1, POSTER_WIDTH / (video.videoWidth || POSTER_WIDTH));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
                canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
                canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
                canvas.toBlob(done, "image/jpeg", 0.85);
            } catch {
                done(null);
            }
        };
        video.onerror = () => done(null);
        document.body.append(video);
        video.src = src;
        video.load();
    });

const POSTER_CONCURRENCY = 2;

export const createAttachments = (canonicalOf?: (id: string) => string | undefined) => {
    const registry = new Map<string, FileEntry>();
    const uploads = new Map<string, Upload>();
    const names = new Map<string, string>();
    let controlled: Promise<boolean> = Promise.resolve(false);
    const posterQueue: (() => void)[] = [];
    let posterActive = 0;

    const withPosterSlot = <T>(task: () => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
            const start = () => {
                posterActive++;
                Promise.resolve()
                    .then(task)
                    .then(resolve, reject)
                    .finally(() => {
                        posterActive--;
                        posterQueue.shift()?.();
                    });
            };
            if (posterActive < POSTER_CONCURRENCY) start();
            else posterQueue.push(start);
        });

    const start = () => {
        const container = navigator.serviceWorker;
        if (!container) return;
        container.addEventListener("message", (event) => {
            const data = event.data as {
                type?: string;
                path?: string;
                blob?: Blob;
                content_type?: string;
            } | null;
            const port = event.ports[0];
            if (!port) return;
            if (data?.type === "fosscord-e2ee-file") port.postMessage(registry.get(String(data.path)) ?? null);
            if (data?.type === "fosscord-e2ee-poster" && data.blob instanceof Blob) {
                const blob = data.blob;
                void withPosterSlot(() => renderPoster(blob, String(data.content_type))).then(
                    (image) => port.postMessage(image),
                    () => port.postMessage(null),
                );
            }
        });
        container.startMessages();
        controlled = new Promise((resolve) => {
            if (container.controller) {
                resolve(true);
                return;
            }
            const timer = setTimeout(() => resolve(false), CONTROL_TIMEOUT_MS);
            container.addEventListener(
                "controllerchange",
                () => {
                    clearTimeout(timer);
                    resolve(true);
                },
                { once: true },
            );
        });
        container.register(SW_PATH, { scope: "/" }).then(
            (registration) => {
                if (!container.controller) registration.active?.postMessage({ type: "fosscord-e2ee-claim" });
            },
            (error) => console.error("[e2ee] couldn't register the attachment service worker", error),
        );
    };

    const prepareCreate = (body: { files?: Record<string, unknown>[] }) => {
        const created: { id: unknown; upload: Upload }[] = [];
        const files = (body.files ?? []).map((file) => {
            const type = typeof file.original_content_type === "string" && file.original_content_type ? file.original_content_type : "application/octet-stream";
            const upload: Upload = {
                name: `${toB64u(randomBytes(12)).replace(/[-_]/g, "0").toLowerCase()}.bin`,
                filename: String(file.filename ?? "file"),
                content_type: type,
                size: Number(file.file_size) || 0,
                key: randomBytes(32),
                iv: randomBytes(12),
                encrypted: null,
                uploaded: false,
            };
            created.push({ id: file.id, upload });
            return {
                id: file.id,
                filename: upload.name,
                file_size: encryptedSize(upload.size),
                is_clip: false,
                original_content_type: "application/octet-stream",
            };
        });
        const track = (response: unknown) => {
            const attachments = (response as { attachments?: CreatedAttachment[] } | null)?.attachments ?? [];
            attachments.forEach((attachment, i) => {
                const upload = created.find((c) => String(c.id) === String(attachment.id))?.upload ?? created[i]?.upload;
                if (!upload) return;
                uploads.set(attachment.upload_url, upload);
                uploads.set(attachment.upload_filename, upload);
            });
        };
        return { body: { ...body, files }, track };
    };

    const isUpload = (url: string) => uploads.has(url);

    const prepareUpload = async (opts: { url: string; body?: unknown; headers?: Record<string, string> }) => {
        const upload = uploads.get(opts.url)!;
        const { "Content-Range": contentRange, ...headers } = opts.headers ?? {};
        if (contentRange && !/^bytes \d+-/.test(contentRange)) return opts;
        const resumeAt = Number(/^bytes (\d+)-/.exec(contentRange ?? "")?.[1] ?? 0);
        if (!upload.encrypted) {
            if (resumeAt || !(opts.body instanceof Blob)) throw new Error("an upload can only be encrypted from its first byte");
            const file = opts.body;
            upload.size = file.size;
            upload.encrypted = encryptFile(file, upload.key, upload.iv);
            Object.assign(upload, await describe(file, upload.content_type));
        }
        const blob = await upload.encrypted;
        const body = resumeAt ? blob.slice(resumeAt) : blob;
        return {
            ...opts,
            body,
            headers: {
                ...headers,
                "Content-Type": "application/octet-stream",
                ...(resumeAt ? { "Content-Range": `bytes ${resumeAt}-${blob.size - 1}/${blob.size}` } : {}),
            },
        };
    };

    const uploaded = (url: string) => {
        const upload = uploads.get(url);
        if (!upload) return;
        upload.uploaded = true;
        upload.encrypted = null;
    };

    const metaFor = (ref: UploadRef): FileMeta | null => {
        const upload = uploads.get(String(ref.uploaded_filename ?? ""));
        if (!upload?.uploaded) return null;
        const meta: FileMeta = {
            name: upload.name,
            filename: typeof ref.filename === "string" && ref.filename ? ref.filename : upload.filename,
            content_type: upload.content_type,
            size: upload.size,
            key: toB64u(upload.key),
            iv: toB64u(upload.iv),
        };
        if (upload.width && upload.height) Object.assign(meta, { width: upload.width, height: upload.height });
        const duration = typeof ref.duration_secs === "number" ? ref.duration_secs : upload.duration_secs;
        if (duration !== undefined) meta.duration_secs = duration;
        if (typeof ref.waveform === "string") meta.waveform = ref.waveform;
        if (typeof ref.description === "string" && ref.description) meta.description = ref.description;
        if (ref.is_spoiler) meta.spoiler = true;
        return meta;
    };

    const sent = (refs: UploadRef[]) => {
        for (const ref of refs) {
            const upload = uploads.get(String(ref.uploaded_filename ?? ""));
            if (!upload) continue;
            for (const [key, value] of uploads) if (value === upload) uploads.delete(key);
        }
    };

    const apply = (message: RawMessage, payload: Payload) => {
        message.content = payload.content;
        const metas = payload.attachments ?? [];
        if (metas.length && Array.isArray(message.attachments))
            message.attachments = message.attachments.map((attachment) => {
                const meta = metas.find((m) => m.name === attachment.filename);
                if (!meta || typeof attachment.url !== "string") return attachment;
                const ciphertextUrl = attachmentCiphertextUrl(attachment.url, message.channel_id, meta.name, location.origin, canonicalOf?.(message.channel_id));
                if (!ciphertextUrl) return attachment;
                const path = new URL(`${FILE_PREFIX}${message.channel_id}/${attachment.id}/${encodeURIComponent(meta.filename)}`, location.origin).pathname;
                names.set(String(attachment.id), meta.name);
                registry.set(path, {
                    url: ciphertextUrl,
                    key: meta.key,
                    iv: meta.iv,
                    content_type: meta.content_type,
                    filename: meta.filename,
                    size: meta.size,
                });
                const url = `${location.origin}${path}`;
                const spoiler = meta.spoiler && !meta.filename.startsWith("SPOILER_");
                const decrypted: Record<string, unknown> = {
                    ...attachment,
                    filename: spoiler ? `SPOILER_${meta.filename}` : meta.filename,
                    content_type: meta.content_type,
                    size: meta.size,
                    url,
                    proxy_url: url,
                    width: meta.width,
                    height: meta.height,
                    flags: meta.spoiler ? (attachment.flags ?? 0) | SPOILER_FLAG : attachment.flags,
                };
                for (const field of ["duration_secs", "waveform", "description"] as const) if (meta[field] !== undefined) decrypted[field] = meta[field];
                for (const field of ["placeholder", "placeholder_version"]) delete decrypted[field];
                return decrypted as typeof attachment;
            });
        if (payload.stickers?.length)
            message.sticker_items = payload.stickers.map(({ id, name, format_type }) => ({
                id,
                name,
                format_type,
            }));
    };

    return {
        start,
        ready: () => controlled,
        prepareCreate,
        isUpload,
        prepareUpload,
        uploaded,
        metaFor,
        sent,
        apply,
        nameOf: (id: string) => names.get(id),
    };
};

export type Attachments = ReturnType<typeof createAttachments>;
