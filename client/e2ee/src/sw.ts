import { decryptFile, FILE_PREFIX, FileEntry, servedType } from "./files";
import { BoundedMap } from "./boundedMap";

interface WaitEvent extends Event {
    waitUntil(promise: Promise<unknown>): void;
}

interface InstallEvent extends WaitEvent {
    addRoutes?: (rules: unknown) => Promise<void>;
}

interface FetchEvent extends WaitEvent {
    request: Request;
    clientId: string;
    respondWith(response: Promise<Response>): void;
}

interface WorkerMessageEvent extends WaitEvent {
    data: unknown;
}

interface WindowClient {
    postMessage(message: unknown, transfer: Transferable[]): void;
}

interface WorkerScope {
    location: Location;
    skipWaiting(): Promise<void>;
    clients: {
        claim(): Promise<void>;
        get(id: string): Promise<WindowClient | undefined>;
        matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    };
    addEventListener(type: "install", listener: (event: InstallEvent) => void): void;
    addEventListener(type: "activate", listener: (event: WaitEvent) => void): void;
    addEventListener(type: "fetch", listener: (event: FetchEvent) => void): void;
    addEventListener(type: "message", listener: (event: WorkerMessageEvent) => void): void;
}

const sw = self as unknown as WorkerScope;
const CACHE_BYTES = 256 * 1024 * 1024;
const ASK_TIMEOUT_MS = 5000;
const POSTER_TIMEOUT_MS = 20000;

const entries = new BoundedMap<string, FileEntry>(2000);
const files = new Map<string, { size: number; blob: Promise<Blob> }>();
const posters = new BoundedMap<string, Promise<Blob | null>>(64);

const ask = async <T>(message: Record<string, unknown>, clientId = "", timeoutMs = ASK_TIMEOUT_MS) => {
    const own = clientId ? await sw.clients.get(clientId) : undefined;
    const windows = own ? [own] : await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!windows.length) return null;
    return new Promise<T | null>((resolve) => {
        let left = windows.length;
        const ports: MessagePort[] = [];
        const finish = (answer: T | null) => {
            clearTimeout(timer);
            for (const port of ports) port.close();
            resolve(answer);
        };
        const timer = setTimeout(() => resolve(null), timeoutMs);
        for (const client of windows) {
            const channel = new MessageChannel();
            ports.push(channel.port1);
            channel.port1.onmessage = (event) => {
                const answer = event.data as T | null;
                if (!answer && --left > 0) return;
                finish(answer);
            };
            client.postMessage(message, [channel.port2]);
        }
    });
};

const plaintext = (path: string, entry: FileEntry) => {
    const hit = files.get(path);
    if (hit) {
        files.delete(path);
        files.set(path, hit);
        return hit.blob;
    }
    const blob = (async () => {
        const res = await fetch(entry.url, { credentials: "same-origin" });
        if (!res.ok) throw new Error(`ciphertext fetch failed with ${res.status}`);
        const parts = await decryptFile(await res.arrayBuffer(), entry.key, entry.iv);
        const out = new Blob(parts);
        if (out.size !== entry.size) throw new Error("decrypted size doesn't match");
        return out;
    })();
    files.set(path, { size: entry.size, blob });
    blob.catch(() => files.delete(path));
    let total = [...files.values()].reduce((sum, file) => sum + file.size, 0);
    for (const [key, file] of files) {
        if (total <= CACHE_BYTES || key === path) break;
        files.delete(key);
        total -= file.size;
    }
    return blob;
};

const missing = (reason: string) =>
    new Response("This content is no longer available.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-E2EE-Error": reason, },
    });

const poster = async (path: string, entry: FileEntry, blob: Blob, clientId: string) => {
    let pending = posters.get(path);
    if (!pending) {
        pending = ask<Blob>({ type: "fosscord-e2ee-poster", blob, content_type: entry.content_type }, clientId, POSTER_TIMEOUT_MS);
        posters.set(path, pending);
        pending.then((image) => image || posters.delete(path));
    }
    const image = await pending;
    if (!image) return missing("preview-unavailable");
    return new Response(image, {
        headers: {
            "Content-Type": image.type || "image/jpeg",
            "Content-Length": String(image.size),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
};

const serve = async (request: Request, url: URL, clientId: string) => {
    const path = url.pathname;
    let entry = entries.get(path);
    if (!entry) {
        entry = (await ask<FileEntry>({ type: "fosscord-e2ee-file", path })) ?? undefined;
        if (!entry) return missing("file-key-unavailable");
        entries.set(path, entry);
    }
    let blob: Blob;
    try {
        blob = await plaintext(path, entry);
    } catch (error) {
        console.error("[e2ee] couldn't decrypt an attachment", error);
        return missing("ciphertext-unavailable-or-invalid");
    }
    if (url.searchParams.has("format") && entry.content_type.startsWith("video/")) return poster(path, entry, blob, clientId);
    const { type, inline } = servedType(entry.content_type);
    const download = url.searchParams.has("download") || !inline;
    const headers: Record<string, string> = {
        "Content-Type": type,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (!range || (!range[1] && !range[2]))
        return new Response(request.method === "HEAD" ? null : blob, {
            status: 200,
            headers: { ...headers, "Content-Length": String(blob.size) },
        });
    const start = range[1] ? Number(range[1]) : Math.max(0, blob.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), blob.size - 1) : blob.size - 1;
    if (start > end || start >= blob.size)
        return new Response(null, {
            status: 416,
            headers: { ...headers, "Content-Range": `bytes */${blob.size}` },
        });
    const body = blob.slice(start, end + 1);
    return new Response(request.method === "HEAD" ? null : body, {
        status: 206,
        headers: {
            ...headers,
            "Content-Length": String(body.size),
            "Content-Range": `bytes ${start}-${end}/${blob.size}`,
        },
    });
};

sw.addEventListener("install", (event) => {
    const routes = (async () =>
        event.addRoutes?.({
            condition: { not: { urlPattern: { pathname: `${FILE_PREFIX}*` } } },
            source: "network",
        }))();
    event.waitUntil(Promise.all([routes.catch(() => {}), sw.skipWaiting()]));
});

sw.addEventListener("activate", (event) => event.waitUntil(sw.clients.claim()));

sw.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type === "fosscord-e2ee-claim") event.waitUntil(sw.clients.claim());
});

sw.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== sw.location.origin || !url.pathname.startsWith(FILE_PREFIX) || !["GET", "HEAD"].includes(event.request.method)) return;
    event.respondWith(serve(event.request, url, event.clientId));
});
