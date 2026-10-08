"use strict";
(() => {
  // client/e2ee/src/bytes.ts
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  var utf8 = (text) => encoder.encode(text);
  var fromB64u = (text) => {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text))
      throw new Error("invalid base64url");
    const binary = atob(
      text
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(text.length / 4) * 4, "="),
    );
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  };

  // client/e2ee/src/files.ts
  var FILE_CHUNK = 64 * 1024;
  var FILE_PREFIX = "/e2ee/attachments/";
  var TAG = 16;
  var CARD_TYPES = new Set(["safety_system_notification", "safety_policy_notice"]);
  var CARD_FIELDS = new Set([
    "icon_type",
    "theme",
    "header",
    "body",
    "timestamp",
    "ctas",
    "learn_more_link",
    "classification_id",
    "incident_time",
  ]);
  var chunkNonce = (iv, index) => {
    const nonce = iv.slice();
    const view = new DataView(nonce.buffer);
    view.setUint32(8, (view.getUint32(8) ^ index) >>> 0);
    return nonce;
  };
  var chunkAad = (index, final) =>
    utf8(`fosscord-e2ee/v1/file
${index}
${final ? 1 : 0}`);
  var fileKey = (raw, usage) =>
    crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
  var decryptFile = async (data, rawKey, rawIv) => {
    const key = await fileKey(fromB64u(rawKey), "decrypt");
    const iv = fromB64u(rawIv);
    if (iv.length !== 12) throw new Error("bad file nonce");
    const count = Math.max(1, Math.ceil(data.byteLength / (FILE_CHUNK + TAG)));
    const parts = [];
    for (let i = 0; i < count; i++) {
      const chunk = data.slice(i * (FILE_CHUNK + TAG), (i + 1) * (FILE_CHUNK + TAG));
      parts.push(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: chunkNonce(iv, i), additionalData: chunkAad(i, i === count - 1) },
          key,
          chunk,
        ),
      );
    }
    return parts;
  };
  var SAFE_INLINE =
    /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|mp4|ogg|wav|webm|aac|flac|x-wav|x-flac)|application\/pdf)$/;
  var TEXTUAL =
    /^(text\/|application\/(json|xml|javascript|x-sh|x-python|toml|yaml|x-yaml)$|image\/svg)/;
  var servedType = (type) => {
    const base = type.split(";")[0].trim().toLowerCase();
    if (SAFE_INLINE.test(base)) return { type: base, inline: true };
    if (TEXTUAL.test(base)) return { type: "text/plain; charset=utf-8", inline: true };
    return { type: "application/octet-stream", inline: false };
  };

  // client/e2ee/src/sw.ts
  var sw = self;
  var CACHE_BYTES = 256 * 1024 * 1024;
  var ASK_TIMEOUT_MS = 5000;
  var entries = new Map();
  var files = new Map();
  var posters = new Map();
  var ask = async (message, clientId = "") => {
    const own = clientId ? await sw.clients.get(clientId) : undefined;
    const windows = own
      ? [own]
      : await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!windows.length) return null;
    return new Promise((resolve) => {
      let left = windows.length;
      const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
      for (const client of windows) {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          const answer = event.data;
          if (!answer && --left > 0) return;
          clearTimeout(timer);
          resolve(answer);
        };
        client.postMessage(message, [channel.port2]);
      }
    });
  };
  var plaintext = (path, entry) => {
    const hit = files.get(path);
    if (hit) {
      files.delete(path);
      files.set(path, hit);
      return hit.blob;
    }
    const blob = (async () => {
      const res = await fetch(entry.url, { credentials: "omit" });
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
  var missing = () =>
    new Response("This content is no longer available.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  var poster = async (path, entry, blob, clientId) => {
    let pending = posters.get(path);
    if (!pending) {
      pending = ask(
        { type: "fosscord-e2ee-poster", blob, content_type: entry.content_type },
        clientId,
      );
      posters.set(path, pending);
      pending.then((image) => image || posters.delete(path));
    }
    const image = await pending;
    if (!image) return missing();
    return new Response(image, {
      headers: {
        "Content-Type": image.type || "image/jpeg",
        "Content-Length": String(image.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
  var serve = async (request, url, clientId) => {
    const path = url.pathname;
    let entry = entries.get(path);
    if (!entry) {
      entry = (await ask({ type: "fosscord-e2ee-file", path })) ?? undefined;
      if (!entry) return missing();
      entries.set(path, entry);
    }
    let blob;
    try {
      blob = await plaintext(path, entry);
    } catch (error) {
      console.error("[e2ee] couldn't decrypt an attachment", error);
      return missing();
    }
    if (url.searchParams.has("format") && entry.content_type.startsWith("video/"))
      return poster(path, entry, blob, clientId);
    const { type, inline } = servedType(entry.content_type);
    const download = url.searchParams.has("download") || !inline;
    const headers = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
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
    if (event.data?.type === "fosscord-e2ee-claim") event.waitUntil(sw.clients.claim());
  });
  sw.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (
      url.origin !== sw.location.origin ||
      !url.pathname.startsWith(FILE_PREFIX) ||
      !["GET", "HEAD"].includes(event.request.method)
    )
      return;
    event.respondWith(serve(event.request, url, event.clientId));
  });
})();
