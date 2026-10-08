"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) =>
    typeof require !== "undefined"
      ? require
      : typeof Proxy !== "undefined"
        ? new Proxy(x, {
            get: (a, b) => (typeof require !== "undefined" ? require : a)[b],
          })
        : x)(function (x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // client/e2ee/src/attachmentUrl.ts
  var attachmentCiphertextUrl = (value, channelId, filename, origin) => {
    let url;
    try {
      url = new URL(value, origin);
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const opened = new URL(origin);
    const localHost =
      /^(?:localhost|[\w.-]+\.localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])$/i.test(
        url.hostname,
      );
    if (url.host !== opened.host && !localHost) return value;
    if (!/^\d+$/.test(channelId)) return null;
    const path = /^\/attachments\/(\d+)\/(\d+)\/([^/]+)$/.exec(url.pathname);
    if (!path || path[1] !== channelId) return null;
    try {
      const decoded = decodeURIComponent(path[3]);
      if (/[/\\\0]/.test(decoded) || decoded !== filename) return null;
    } catch {
      return null;
    }
    return `${opened.origin}${url.pathname}${url.search}${url.hash}`;
  };

  // client/e2ee/src/bytes.ts
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  var utf8 = (text) => encoder.encode(text);
  var fromUtf8 = (bytes) => decoder.decode(bytes);
  var toB64u = (input) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768)
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
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
  var randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
  var sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

  // client/e2ee/src/safetyNoticeText.ts
  var SAFETY_STANDING_URL = "https://meowcord.invalid/settings/account/account-standing";
  function readableSafetyNotice(content) {
    const match =
      /^\*\*icon_type\*\*\n(default|danger)\n\n\*\*theme\*\*\n(default|danger)\n\n\*\*header\*\*\n([^\n]+)\n\n\*\*body\*\*\n([\s\S]*?)\n\n\*\*timestamp\*\*\n\d{9,12}\n\n\*\*ctas\*\*(?:\n)?([\s\S]*)$/.exec(
        content,
      );
    if (!match) return content;
    const tail = match[5];
    if (
      !/^(?:account_standing|policy_violation_detail|learn_more_link)?(?:\n\n\*\*classification_id\*\*\n\d{1,20})?(?:\n\n\*\*learn_more_link\*\*\nhttps?:\/\/[^\s]+)?$/.test(
        tail,
      )
    )
      return content;
    let learnMore = "";
    const link = /\*\*learn_more_link\*\*\n([^\s]+)$/.exec(tail)?.[1];
    if (link) {
      try {
        const url = new URL(link);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
          learnMore = `

[Learn more](${url.href.replaceAll("(", "%28").replaceAll(")", "%29")})`;
      } catch {
        learnMore = "";
      }
    }
    return `**${match[3]}**

${match[4]}

[Review Account Standing](${SAFETY_STANDING_URL})${learnMore}`;
  }

  // client/e2ee/src/files.ts
  var FILE_CHUNK = 64 * 1024;
  var FILE_PREFIX = "/e2ee/attachments/";
  var SW_PATH = "/e2ee-sw.js";
  var TAG = 16;
  var encryptedSize = (size) => size + TAG * Math.max(1, Math.ceil(size / FILE_CHUNK));
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
  var encryptFile = async (blob, raw, iv) => {
    const key = await fileKey(raw, "encrypt");
    const count = Math.max(1, Math.ceil(blob.size / FILE_CHUNK));
    const parts = [];
    for (let i = 0; i < count; i++) {
      const plain = await blob.slice(i * FILE_CHUNK, (i + 1) * FILE_CHUNK).arrayBuffer();
      parts.push(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: chunkNonce(iv, i), additionalData: chunkAad(i, i === count - 1) },
          key,
          plain,
        ),
      );
    }
    return new Blob(parts, { type: "application/octet-stream" });
  };
  var str = (value, max) => (typeof value === "string" && value.length <= max ? value : undefined);
  var num = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  var parseFile = (item) => {
    const name = str(item?.name, 200);
    const filename = str(item?.filename, 1024);
    const key = str(item?.key, 64);
    const iv = str(item?.iv, 32);
    const size = num(item?.size);
    if (!item || !name || !filename || !key || !iv || size === undefined) return [];
    const meta = {
      name,
      filename,
      key,
      iv,
      size,
      content_type: str(item.content_type, 255) ?? "application/octet-stream",
    };
    const width = num(item.width);
    const height = num(item.height);
    if (width && height) Object.assign(meta, { width, height });
    const duration = num(item.duration_secs);
    if (duration !== undefined) meta.duration_secs = duration;
    const waveform = str(item.waveform, 4096);
    if (waveform) meta.waveform = waveform;
    const description = str(item.description, 1024);
    if (description) meta.description = description;
    if (item.spoiler === true) meta.spoiler = true;
    return [meta];
  };
  var parsePayload = (raw) => {
    const value = raw && typeof raw === "object" ? raw : {};
    const payload = {
      content: typeof value.content === "string" ? readableSafetyNotice(value.content) : "",
    };
    if (Array.isArray(value.attachments))
      payload.attachments = value.attachments.flatMap(parseFile);
    if (Array.isArray(value.stickers))
      payload.stickers = value.stickers.flatMap((item) => {
        const id = str(item?.id, 32);
        if (!id || !/^\d+$/.test(id)) return [];
        return [{ id, name: str(item?.name, 100) ?? "", format_type: num(item?.format_type) ?? 1 }];
      });
    return payload;
  };

  // client/e2ee/src/attachments.ts
  var CONTROL_TIMEOUT_MS = 8000;
  var SPOILER_FLAG = 1 << 3;
  var describe = async (file, type) => {
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
      const done = (value) => {
        clearTimeout(timer);
        media.removeAttribute("src");
        URL.revokeObjectURL(src);
        resolve(value);
      };
      const timer = setTimeout(() => done({}), 5000);
      media.preload = "metadata";
      media.muted = true;
      media.onloadedmetadata = () => {
        const video =
          media instanceof HTMLVideoElement && media.videoWidth
            ? { width: media.videoWidth, height: media.videoHeight }
            : {};
        done({
          ...video,
          ...(Number.isFinite(media.duration) ? { duration_secs: media.duration } : {}),
        });
      };
      media.onerror = () => done({});
      media.src = src;
    });
  };
  var POSTER_WIDTH = 1280;
  var renderPoster = (blob, type) =>
    new Promise((resolve) => {
      const video = document.createElement("video");
      const src = URL.createObjectURL(new Blob([blob], { type }));
      const done = (image) => {
        clearTimeout(timer);
        video.removeAttribute("src");
        URL.revokeObjectURL(src);
        resolve(image);
      };
      const timer = setTimeout(() => done(null), 1e4);
      video.muted = true;
      video.preload = "auto";
      video.onloadeddata = () => {
        const scale = Math.min(1, POSTER_WIDTH / (video.videoWidth || POSTER_WIDTH));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(done, "image/jpeg", 0.85);
      };
      video.onerror = () => done(null);
      video.src = src;
    });
  var createAttachments = () => {
    const registry = new Map();
    const uploads = new Map();
    const names = new Map();
    let controlled = Promise.resolve(false);
    const start = () => {
      const container = navigator.serviceWorker;
      if (!container) return;
      container.addEventListener("message", (event) => {
        const data = event.data;
        const port = event.ports[0];
        if (!port) return;
        if (data?.type === "fosscord-e2ee-file")
          port.postMessage(registry.get(String(data.path)) ?? null);
        if (data?.type === "fosscord-e2ee-poster" && data.blob instanceof Blob)
          renderPoster(data.blob, String(data.content_type)).then(
            (image) => port.postMessage(image),
            () => port.postMessage(null),
          );
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
          if (!container.controller)
            registration.active?.postMessage({ type: "fosscord-e2ee-claim" });
        },
        (error) => console.error("[e2ee] couldn't register the attachment service worker", error),
      );
    };
    const prepareCreate = (body) => {
      const created = [];
      const files = (body.files ?? []).map((file) => {
        const type =
          typeof file.original_content_type === "string" && file.original_content_type
            ? file.original_content_type
            : "application/octet-stream";
        const upload = {
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
      const track = (response) => {
        const attachments = response?.attachments ?? [];
        attachments.forEach((attachment, i) => {
          const upload =
            created.find((c) => String(c.id) === String(attachment.id))?.upload ??
            created[i]?.upload;
          if (!upload) return;
          uploads.set(attachment.upload_url, upload);
          uploads.set(attachment.upload_filename, upload);
        });
      };
      return { body: { ...body, files }, track };
    };
    const isUpload = (url) => uploads.has(url);
    const prepareUpload = async (opts) => {
      const upload = uploads.get(opts.url);
      const { "Content-Range": contentRange, ...headers } = opts.headers ?? {};
      if (contentRange && !/^bytes \d+-/.test(contentRange)) return opts;
      const resumeAt = Number(/^bytes (\d+)-/.exec(contentRange ?? "")?.[1] ?? 0);
      if (!upload.encrypted) {
        if (resumeAt || !(opts.body instanceof Blob))
          throw new Error("an upload can only be encrypted from its first byte");
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
          ...(resumeAt
            ? { "Content-Range": `bytes ${resumeAt}-${blob.size - 1}/${blob.size}` }
            : {}),
        },
      };
    };
    const uploaded = (url) => {
      const upload = uploads.get(url);
      if (!upload) return;
      upload.uploaded = true;
      upload.encrypted = null;
    };
    const metaFor = (ref) => {
      const upload = uploads.get(String(ref.uploaded_filename ?? ""));
      if (!upload?.uploaded) return null;
      const meta = {
        name: upload.name,
        filename: typeof ref.filename === "string" && ref.filename ? ref.filename : upload.filename,
        content_type: upload.content_type,
        size: upload.size,
        key: toB64u(upload.key),
        iv: toB64u(upload.iv),
      };
      if (upload.width && upload.height)
        Object.assign(meta, { width: upload.width, height: upload.height });
      const duration =
        typeof ref.duration_secs === "number" ? ref.duration_secs : upload.duration_secs;
      if (duration !== undefined) meta.duration_secs = duration;
      if (typeof ref.waveform === "string") meta.waveform = ref.waveform;
      if (typeof ref.description === "string" && ref.description)
        meta.description = ref.description;
      if (ref.is_spoiler) meta.spoiler = true;
      return meta;
    };
    const sent = (refs) => {
      for (const ref of refs) {
        const upload = uploads.get(String(ref.uploaded_filename ?? ""));
        if (!upload) continue;
        for (const [key, value] of uploads) if (value === upload) uploads.delete(key);
      }
    };
    const apply = (message, payload) => {
      message.content = payload.content;
      const metas = payload.attachments ?? [];
      if (metas.length && Array.isArray(message.attachments))
        message.attachments = message.attachments.map((attachment) => {
          const meta = metas.find((m) => m.name === attachment.filename);
          if (!meta || typeof attachment.url !== "string") return attachment;
          const ciphertextUrl = attachmentCiphertextUrl(
            attachment.url,
            message.channel_id,
            meta.name,
            location.origin,
          );
          if (!ciphertextUrl) return attachment;
          const path = new URL(
            `${FILE_PREFIX}${message.channel_id}/${attachment.id}/${encodeURIComponent(meta.filename)}`,
            location.origin,
          ).pathname;
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
          const decrypted = {
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
          for (const field of ["duration_secs", "waveform", "description"])
            if (meta[field] !== undefined) decrypted[field] = meta[field];
          for (const field of ["placeholder", "placeholder_version"]) delete decrypted[field];
          return decrypted;
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
      nameOf: (id) => names.get(id),
    };
  };
  // node_modules/@hpke/common/esm/src/errors.js
  class HpkeError extends Error {
    constructor(e) {
      let message;
      if (e instanceof Error) {
        message = e.message;
      } else if (typeof e === "string") {
        message = e;
      } else {
        message = "";
      }
      super(message);
      this.name = this.constructor.name;
    }
  }

  class InvalidParamError extends HpkeError {}
  class SerializeError extends HpkeError {}

  class DeserializeError extends HpkeError {}

  class EncapError extends HpkeError {}

  class DecapError extends HpkeError {}

  class ExportError extends HpkeError {}

  class SealError extends HpkeError {}

  class OpenError extends HpkeError {}

  class MessageLimitReachedError extends HpkeError {}

  class DeriveKeyPairError extends HpkeError {}

  class NotSupportedError extends HpkeError {}
  // node_modules/@hpke/common/esm/_dnt.shims.js
  var dntGlobals = {};
  var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
  function createMergeProxy(baseObj, extObj) {
    return new Proxy(baseObj, {
      get(_target, prop, _receiver) {
        if (prop in extObj) {
          return extObj[prop];
        } else {
          return baseObj[prop];
        }
      },
      set(_target, prop, value) {
        if (prop in extObj) {
          delete extObj[prop];
        }
        baseObj[prop] = value;
        return true;
      },
      deleteProperty(_target, prop) {
        let success = false;
        if (prop in extObj) {
          delete extObj[prop];
          success = true;
        }
        if (prop in baseObj) {
          delete baseObj[prop];
          success = true;
        }
        return success;
      },
      ownKeys(_target) {
        const baseKeys = Reflect.ownKeys(baseObj);
        const extKeys = Reflect.ownKeys(extObj);
        const extKeysSet = new Set(extKeys);
        return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
      },
      defineProperty(_target, prop, desc) {
        if (prop in extObj) {
          delete extObj[prop];
        }
        Reflect.defineProperty(baseObj, prop, desc);
        return true;
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (prop in extObj) {
          return Reflect.getOwnPropertyDescriptor(extObj, prop);
        } else {
          return Reflect.getOwnPropertyDescriptor(baseObj, prop);
        }
      },
      has(_target, prop) {
        return prop in extObj || prop in baseObj;
      },
    });
  }

  // node_modules/@hpke/common/esm/src/algorithm.js
  async function loadSubtleCrypto() {
    if (dntGlobalThis !== undefined && globalThis.crypto !== undefined) {
      return globalThis.crypto.subtle;
    }
    try {
      const { webcrypto } = await import("crypto");
      return webcrypto.subtle;
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }

  class NativeAlgorithm {
    constructor() {
      Object.defineProperty(this, "_api", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
    async _setup() {
      if (this._api !== undefined) {
        return;
      }
      this._api = await loadSubtleCrypto();
    }
  }
  // node_modules/@hpke/common/esm/src/identifiers.js
  var Mode = {
    Base: 0,
    Psk: 1,
    Auth: 2,
    AuthPsk: 3,
  };
  var KemId = {
    NotAssigned: 0,
    DhkemP256HkdfSha256: 16,
    DhkemP384HkdfSha384: 17,
    DhkemP521HkdfSha512: 18,
    DhkemSecp256k1HkdfSha256: 19,
    DhkemX25519HkdfSha256: 32,
    DhkemX448HkdfSha512: 33,
    HybridkemX25519Kyber768: 48,
    MlKem512: 64,
    MlKem768: 65,
    MlKem1024: 66,
    XWing: 25722,
  };
  var KdfId = {
    HkdfSha256: 1,
    HkdfSha384: 2,
    HkdfSha512: 3,
    Sha3256: 4,
    Sha3384: 5,
    Sha3512: 6,
    Shake128: 16,
    Shake256: 17,
    TurboShake128: 18,
    TurboShake256: 19,
  };
  var AeadId = {
    Aes128Gcm: 1,
    Aes256Gcm: 2,
    Chacha20Poly1305: 3,
    ExportOnly: 65535,
  };
  // node_modules/@hpke/common/esm/src/consts.js
  var INPUT_LENGTH_LIMIT = 8192;
  var INFO_LENGTH_LIMIT = 268435456;
  var MINIMUM_PSK_LENGTH = 32;
  var EMPTY = /* @__PURE__ */ new Uint8Array(0);

  // node_modules/@hpke/common/esm/src/interfaces/kemInterface.js
  var SUITE_ID_HEADER_KEM = /* @__PURE__ */ new Uint8Array([75, 69, 77, 0, 0]);

  // node_modules/@hpke/common/esm/src/kdfs/hkdf.js
  var HPKE_VERSION = /* @__PURE__ */ new Uint8Array([72, 80, 75, 69, 45, 118, 49]);
  function toUint8Array(input) {
    return new Uint8Array(toArrayBuffer(input));
  }
  function toArrayBuffer(input) {
    if (input instanceof ArrayBuffer) {
      return input;
    }
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice().buffer;
    }
    return new Uint8Array(input).slice().buffer;
  }

  class HkdfNative extends NativeAlgorithm {
    constructor() {
      super();
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KdfId.HkdfSha256,
      });
      Object.defineProperty(this, "hashSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(this, "_suiteId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: EMPTY,
      });
      Object.defineProperty(this, "algHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          name: "HMAC",
          hash: "SHA-256",
          length: 256,
        },
      });
    }
    init(suiteId) {
      this._suiteId = suiteId;
    }
    buildLabeledIkm(label, ikm) {
      this._checkInit();
      const ret = new Uint8Array(7 + this._suiteId.byteLength + label.byteLength + ikm.byteLength);
      ret.set(HPKE_VERSION, 0);
      ret.set(this._suiteId, 7);
      ret.set(label, 7 + this._suiteId.byteLength);
      ret.set(ikm, 7 + this._suiteId.byteLength + label.byteLength);
      return ret;
    }
    buildLabeledInfo(label, info, len) {
      this._checkInit();
      const ret = new Uint8Array(9 + this._suiteId.byteLength + label.byteLength + info.byteLength);
      ret.set(new Uint8Array([0, len]), 0);
      ret.set(HPKE_VERSION, 2);
      ret.set(this._suiteId, 9);
      ret.set(label, 9 + this._suiteId.byteLength);
      ret.set(info, 9 + this._suiteId.byteLength + label.byteLength);
      return ret;
    }
    async extract(salt, ikm) {
      await this._setup();
      const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
      if (saltBuf.byteLength !== this.hashSize) {
        throw new InvalidParamError("The salt length must be the same as the hashSize");
      }
      const ikmBuf = toArrayBuffer(ikm);
      const key = await this._api.importKey("raw", saltBuf, this.algHash, false, ["sign"]);
      return await this._api.sign("HMAC", key, ikmBuf);
    }
    async expand(prk, info, len) {
      await this._setup();
      const prkBuf = toArrayBuffer(prk);
      const key = await this._api.importKey("raw", prkBuf, this.algHash, false, ["sign"]);
      const okm = new ArrayBuffer(len);
      const okmBytes = new Uint8Array(okm);
      let prev = EMPTY;
      const mid = toUint8Array(info);
      const tail = new Uint8Array(1);
      if (len > 255 * this.hashSize) {
        throw new Error("Entropy limit reached");
      }
      const tmp = new Uint8Array(this.hashSize + mid.length + 1);
      for (let i = 1, cur = 0; cur < okmBytes.length; i++) {
        tail[0] = i;
        tmp.set(prev, 0);
        tmp.set(mid, prev.length);
        tmp.set(tail, prev.length + mid.length);
        prev = new Uint8Array(
          await this._api.sign("HMAC", key, tmp.slice(0, prev.length + mid.length + 1)),
        );
        if (okmBytes.length - cur >= prev.length) {
          okmBytes.set(prev, cur);
          cur += prev.length;
        } else {
          okmBytes.set(prev.slice(0, okmBytes.length - cur), cur);
          cur += okmBytes.length - cur;
        }
      }
      return okm;
    }
    async extractAndExpand(salt, ikm, info, len) {
      await this._setup();
      const ikmBuf = toArrayBuffer(ikm);
      const baseKey = await this._api.importKey("raw", ikmBuf, "HKDF", false, ["deriveBits"]);
      return await this._api.deriveBits(
        {
          name: "HKDF",
          hash: this.algHash.hash,
          salt: toArrayBuffer(salt),
          info: toArrayBuffer(info),
        },
        baseKey,
        len * 8,
      );
    }
    async labeledExtract(salt, label, ikm) {
      return await this.extract(salt, this.buildLabeledIkm(label, ikm));
    }
    async labeledExpand(prk, label, info, len) {
      return await this.expand(prk, this.buildLabeledInfo(label, info, len), len);
    }
    _checkInit() {
      if (this._suiteId === EMPTY) {
        throw new Error("Not initialized. Call init()");
      }
    }
  }

  class HkdfSha256Native extends HkdfNative {
    constructor() {
      super(...arguments);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KdfId.HkdfSha256,
      });
      Object.defineProperty(this, "hashSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32,
      });
      Object.defineProperty(this, "algHash", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: {
          name: "HMAC",
          hash: "SHA-256",
          length: 256,
        },
      });
    }
  }

  // node_modules/@hpke/common/esm/src/utils/misc.js
  var isCryptoKeyPair = (x) =>
    typeof x === "object" &&
    x !== null &&
    typeof x.privateKey === "object" &&
    typeof x.publicKey === "object";
  function i2Osp(n, w) {
    if (w <= 0) {
      throw new Error("i2Osp: too small size");
    }
    if (n >= 256 ** w) {
      throw new Error("i2Osp: too large integer");
    }
    const ret = new Uint8Array(w);
    for (let i = 0; i < w && n; i++) {
      ret[w - (i + 1)] = n % 256;
      n = Math.floor(n / 256);
    }
    return ret;
  }
  function concat(a, b) {
    const ret = new Uint8Array(a.length + b.length);
    ret.set(a, 0);
    ret.set(b, a.length);
    return ret;
  }
  function base64UrlToBytes(v) {
    const base64 = v.replace(/-/g, "+").replace(/_/g, "/");
    const byteString = atob(base64);
    const ret = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) {
      ret[i] = byteString.charCodeAt(i);
    }
    return ret;
  }
  function xor(a, b) {
    if (a.byteLength !== b.byteLength) {
      throw new Error("xor: different length inputs");
    }
    const buf = new Uint8Array(a.byteLength);
    for (let i = 0; i < a.byteLength; i++) {
      buf[i] = a[i] ^ b[i];
    }
    return buf;
  }

  // node_modules/@hpke/common/esm/src/kems/dhkem.js
  var LABEL_EAE_PRK = /* @__PURE__ */ new Uint8Array([101, 97, 101, 95, 112, 114, 107]);
  var LABEL_SHARED_SECRET = /* @__PURE__ */ new Uint8Array([
    115, 104, 97, 114, 101, 100, 95, 115, 101, 99, 114, 101, 116,
  ]);
  function concat3(a, b, c) {
    const ret = new Uint8Array(a.length + b.length + c.length);
    ret.set(a, 0);
    ret.set(b, a.length);
    ret.set(c, a.length + b.length);
    return ret;
  }

  class Dhkem {
    constructor(id, prim, kdf) {
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 0,
      });
      Object.defineProperty(this, "_prim", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_kdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      this.id = id;
      this._prim = prim;
      this._kdf = kdf;
      const suiteId = new Uint8Array(SUITE_ID_HEADER_KEM);
      suiteId.set(i2Osp(this.id, 2), 3);
      this._kdf.init(suiteId);
    }
    async serializePublicKey(key) {
      return await this._prim.serializePublicKey(key);
    }
    async deserializePublicKey(key) {
      return await this._prim.deserializePublicKey(toArrayBuffer(key));
    }
    async serializePrivateKey(key) {
      return await this._prim.serializePrivateKey(key);
    }
    async deserializePrivateKey(key) {
      return await this._prim.deserializePrivateKey(toArrayBuffer(key));
    }
    async importKey(format, key, isPublic = true) {
      return await this._prim.importKey(format, key, isPublic);
    }
    async generateKeyPair() {
      return await this._prim.generateKeyPair();
    }
    async deriveKeyPair(ikm) {
      const rawIkm = toArrayBuffer(ikm);
      if (rawIkm.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long ikm");
      }
      return await this._prim.deriveKeyPair(rawIkm);
    }
    async encap(params) {
      let ke;
      if (params.ekm === undefined) {
        ke = await this.generateKeyPair();
      } else if (isCryptoKeyPair(params.ekm)) {
        ke = params.ekm;
      } else {
        ke = await this.deriveKeyPair(params.ekm);
      }
      const enc = await this._prim.serializePublicKey(ke.publicKey);
      const pkrm = await this._prim.serializePublicKey(params.recipientPublicKey);
      try {
        let dh;
        if (params.senderKey === undefined) {
          dh = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
        } else {
          const sks = isCryptoKeyPair(params.senderKey)
            ? params.senderKey.privateKey
            : params.senderKey;
          const dh1 = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
          const dh2 = new Uint8Array(await this._prim.dh(sks, params.recipientPublicKey));
          dh = concat(dh1, dh2);
        }
        let kemContext;
        if (params.senderKey === undefined) {
          kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
        } else {
          const pks = isCryptoKeyPair(params.senderKey)
            ? params.senderKey.publicKey
            : await this._prim.derivePublicKey(params.senderKey);
          const pksm = await this._prim.serializePublicKey(pks);
          kemContext = concat3(new Uint8Array(enc), new Uint8Array(pkrm), new Uint8Array(pksm));
        }
        const sharedSecret = await this._generateSharedSecret(dh, kemContext);
        return {
          enc,
          sharedSecret,
        };
      } catch (e) {
        throw new EncapError(e);
      }
    }
    async decap(params) {
      const enc = toArrayBuffer(params.enc);
      const pke = await this._prim.deserializePublicKey(enc);
      const skr = isCryptoKeyPair(params.recipientKey)
        ? params.recipientKey.privateKey
        : params.recipientKey;
      const pkr = isCryptoKeyPair(params.recipientKey)
        ? params.recipientKey.publicKey
        : await this._prim.derivePublicKey(params.recipientKey);
      const pkrm = await this._prim.serializePublicKey(pkr);
      try {
        let dh;
        if (params.senderPublicKey === undefined) {
          dh = new Uint8Array(await this._prim.dh(skr, pke));
        } else {
          const dh1 = new Uint8Array(await this._prim.dh(skr, pke));
          const dh2 = new Uint8Array(await this._prim.dh(skr, params.senderPublicKey));
          dh = concat(dh1, dh2);
        }
        let kemContext;
        if (params.senderPublicKey === undefined) {
          kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
        } else {
          const pksm = await this._prim.serializePublicKey(params.senderPublicKey);
          kemContext = new Uint8Array(enc.byteLength + pkrm.byteLength + pksm.byteLength);
          kemContext.set(new Uint8Array(enc), 0);
          kemContext.set(new Uint8Array(pkrm), enc.byteLength);
          kemContext.set(new Uint8Array(pksm), enc.byteLength + pkrm.byteLength);
        }
        return await this._generateSharedSecret(dh, kemContext);
      } catch (e) {
        throw new DecapError(e);
      }
    }
    async _generateSharedSecret(dh, kemContext) {
      const labeledIkm = this._kdf.buildLabeledIkm(LABEL_EAE_PRK, dh);
      const labeledInfo = this._kdf.buildLabeledInfo(
        LABEL_SHARED_SECRET,
        kemContext,
        this.secretSize,
      );
      return await this._kdf.extractAndExpand(EMPTY, labeledIkm, labeledInfo, this.secretSize);
    }
  }
  // node_modules/@hpke/common/esm/src/interfaces/dhkemPrimitives.js
  var KEM_USAGES = ["deriveBits"];
  var LABEL_DKP_PRK = /* @__PURE__ */ new Uint8Array([100, 107, 112, 95, 112, 114, 107]);
  var LABEL_SK = /* @__PURE__ */ new Uint8Array([115, 107]);
  // node_modules/@hpke/common/esm/src/interfaces/aeadEncryptionContext.js
  var AEAD_USAGES = ["encrypt", "decrypt"];
  // node_modules/@hpke/core/esm/src/aeads/aesGcm.js
  class AesGcmContext extends NativeAlgorithm {
    constructor(key) {
      super();
      Object.defineProperty(this, "_rawKey", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_key", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      this._rawKey = toArrayBuffer(key);
    }
    async seal(iv, data, aad) {
      await this._setupKey();
      const alg = {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad),
      };
      const ct = await this._api.encrypt(alg, this._key, toArrayBuffer(data));
      return ct;
    }
    async open(iv, data, aad) {
      await this._setupKey();
      const alg = {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad),
      };
      const pt = await this._api.decrypt(alg, this._key, toArrayBuffer(data));
      return pt;
    }
    async _setupKey() {
      if (this._key !== undefined) {
        return;
      }
      await this._setup();
      const key = await this._importKey(this._rawKey);
      new Uint8Array(this._rawKey).fill(0);
      this._key = key;
      return;
    }
    async _importKey(key) {
      return await this._api.importKey("raw", key, { name: "AES-GCM" }, true, AEAD_USAGES);
    }
  }

  class Aes128Gcm {
    constructor() {
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: AeadId.Aes128Gcm,
      });
      Object.defineProperty(this, "keySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16,
      });
      Object.defineProperty(this, "nonceSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 12,
      });
      Object.defineProperty(this, "tagSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16,
      });
    }
    createEncryptionContext(key) {
      return new AesGcmContext(key);
    }
  }

  class Aes256Gcm extends Aes128Gcm {
    constructor() {
      super(...arguments);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: AeadId.Aes256Gcm,
      });
      Object.defineProperty(this, "keySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32,
      });
      Object.defineProperty(this, "nonceSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 12,
      });
      Object.defineProperty(this, "tagSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 16,
      });
    }
  }
  // node_modules/@hpke/core/esm/src/utils/emitNotSupported.js
  function emitNotSupported() {
    return new Promise((_resolve, reject) => {
      reject(new NotSupportedError("Not supported"));
    });
  }

  // node_modules/@hpke/core/esm/src/exporterContext.js
  var LABEL_SEC = new Uint8Array([115, 101, 99]);

  class ExporterContextImpl {
    constructor(api, kdf, exporterSecret) {
      Object.defineProperty(this, "_api", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "exporterSecret", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_kdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      this._api = api;
      this._kdf = kdf;
      this.exporterSecret = exporterSecret;
    }
    async seal(_data, _aad) {
      return await emitNotSupported();
    }
    async open(_data, _aad) {
      return await emitNotSupported();
    }
    async export(exporterContext, len) {
      const rawExporterContext = toArrayBuffer(exporterContext);
      if (rawExporterContext.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long exporter context");
      }
      try {
        return await this._kdf.labeledExpand(
          this.exporterSecret,
          LABEL_SEC,
          new Uint8Array(rawExporterContext),
          len,
        );
      } catch (e) {
        throw new ExportError(e);
      }
    }
  }

  class RecipientExporterContextImpl extends ExporterContextImpl {}

  class SenderExporterContextImpl extends ExporterContextImpl {
    constructor(api, kdf, exporterSecret, enc) {
      super(api, kdf, exporterSecret);
      Object.defineProperty(this, "enc", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      this.enc = enc;
      return;
    }
  }

  // node_modules/@hpke/core/esm/src/encryptionContext.js
  class EncryptionContextImpl extends ExporterContextImpl {
    constructor(api, kdf, params) {
      super(api, kdf, params.exporterSecret);
      Object.defineProperty(this, "_aead", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_nK", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_nN", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_nT", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_ctx", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      if (params.key === undefined || params.baseNonce === undefined || params.seq === undefined) {
        throw new Error("Required parameters are missing");
      }
      this._aead = params.aead;
      this._nK = this._aead.keySize;
      this._nN = this._aead.nonceSize;
      this._nT = this._aead.tagSize;
      const key = this._aead.createEncryptionContext(params.key);
      this._ctx = {
        key,
        baseNonce: params.baseNonce,
        seq: params.seq,
      };
    }
    computeNonce(k) {
      const seqBytes = i2Osp(k.seq, k.baseNonce.byteLength);
      return xor(k.baseNonce, seqBytes).buffer;
    }
    incrementSeq(k) {
      if (k.seq > Number.MAX_SAFE_INTEGER) {
        throw new MessageLimitReachedError("Message limit reached");
      }
      k.seq += 1;
      return;
    }
  }

  // node_modules/@hpke/core/esm/src/mutex.js
  var __classPrivateFieldGet = function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        "Cannot read private member from an object whose class did not declare it",
      );
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
  var __classPrivateFieldSet = function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        "Cannot write private member to an object whose class did not declare it",
      );
    return (
      kind === "a" ? f.call(receiver, value) : f ? (f.value = value) : state.set(receiver, value),
      value
    );
  };
  var _Mutex_locked;

  class Mutex {
    constructor() {
      _Mutex_locked.set(this, Promise.resolve());
    }
    async lock() {
      let releaseLock;
      const nextLock = new Promise((resolve) => {
        releaseLock = resolve;
      });
      const previousLock = __classPrivateFieldGet(this, _Mutex_locked, "f");
      __classPrivateFieldSet(this, _Mutex_locked, nextLock, "f");
      await previousLock;
      return releaseLock;
    }
  }
  _Mutex_locked = new WeakMap();

  // node_modules/@hpke/core/esm/src/recipientContext.js
  var __classPrivateFieldGet2 = function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        "Cannot read private member from an object whose class did not declare it",
      );
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
  var __classPrivateFieldSet2 = function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        "Cannot write private member to an object whose class did not declare it",
      );
    return (
      kind === "a" ? f.call(receiver, value) : f ? (f.value = value) : state.set(receiver, value),
      value
    );
  };
  var _RecipientContextImpl_mutex;

  class RecipientContextImpl extends EncryptionContextImpl {
    constructor() {
      super(...arguments);
      _RecipientContextImpl_mutex.set(this, undefined);
    }
    async open(data, aad = EMPTY.buffer) {
      __classPrivateFieldSet2(
        this,
        _RecipientContextImpl_mutex,
        __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f") ?? new Mutex(),
        "f",
      );
      const release = await __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f").lock();
      let pt;
      try {
        pt = await this._ctx.key.open(
          this.computeNonce(this._ctx),
          toArrayBuffer(data),
          toArrayBuffer(aad),
        );
      } catch (e) {
        throw new OpenError(e);
      } finally {
        release();
      }
      this.incrementSeq(this._ctx);
      return pt;
    }
  }
  _RecipientContextImpl_mutex = new WeakMap();

  // node_modules/@hpke/core/esm/src/senderContext.js
  var __classPrivateFieldGet3 = function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        "Cannot read private member from an object whose class did not declare it",
      );
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
  };
  var __classPrivateFieldSet3 = function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
      throw new TypeError(
        "Cannot write private member to an object whose class did not declare it",
      );
    return (
      kind === "a" ? f.call(receiver, value) : f ? (f.value = value) : state.set(receiver, value),
      value
    );
  };
  var _SenderContextImpl_mutex;

  class SenderContextImpl extends EncryptionContextImpl {
    constructor(api, kdf, params, enc) {
      super(api, kdf, params);
      Object.defineProperty(this, "enc", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      _SenderContextImpl_mutex.set(this, undefined);
      this.enc = enc;
    }
    async seal(data, aad = EMPTY.buffer) {
      __classPrivateFieldSet3(
        this,
        _SenderContextImpl_mutex,
        __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f") ?? new Mutex(),
        "f",
      );
      const release = await __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f").lock();
      let ct;
      try {
        ct = await this._ctx.key.seal(
          this.computeNonce(this._ctx),
          toArrayBuffer(data),
          toArrayBuffer(aad),
        );
      } catch (e) {
        throw new SealError(e);
      } finally {
        release();
      }
      this.incrementSeq(this._ctx);
      return ct;
    }
  }
  _SenderContextImpl_mutex = new WeakMap();

  // node_modules/@hpke/core/esm/src/cipherSuiteNative.js
  var LABEL_BASE_NONCE = new Uint8Array([98, 97, 115, 101, 95, 110, 111, 110, 99, 101]);
  var LABEL_EXP = new Uint8Array([101, 120, 112]);
  var LABEL_INFO_HASH = new Uint8Array([105, 110, 102, 111, 95, 104, 97, 115, 104]);
  var LABEL_KEY = new Uint8Array([107, 101, 121]);
  var LABEL_PSK_ID_HASH = new Uint8Array([112, 115, 107, 95, 105, 100, 95, 104, 97, 115, 104]);
  var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
  var SUITE_ID_HEADER_HPKE = new Uint8Array([72, 80, 75, 69, 0, 0, 0, 0, 0, 0]);

  class CipherSuiteNative extends NativeAlgorithm {
    constructor(params) {
      super();
      Object.defineProperty(this, "_kem", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_kdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_aead", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_suiteId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      if (typeof params.kem === "number") {
        throw new InvalidParamError("KemId cannot be used");
      }
      this._kem = params.kem;
      if (typeof params.kdf === "number") {
        throw new InvalidParamError("KdfId cannot be used");
      }
      this._kdf = params.kdf;
      if (typeof params.aead === "number") {
        throw new InvalidParamError("AeadId cannot be used");
      }
      this._aead = params.aead;
      this._suiteId = new Uint8Array(SUITE_ID_HEADER_HPKE);
      this._suiteId.set(i2Osp(this._kem.id, 2), 4);
      this._suiteId.set(i2Osp(this._kdf.id, 2), 6);
      this._suiteId.set(i2Osp(this._aead.id, 2), 8);
      this._kdf.init(this._suiteId);
    }
    get kem() {
      return this._kem;
    }
    get kdf() {
      return this._kdf;
    }
    get aead() {
      return this._aead;
    }
    async createSenderContext(params) {
      this._validateInputLength(params);
      await this._setup();
      const dh = await this._kem.encap(params);
      let mode;
      if (params.psk !== undefined) {
        mode = params.senderKey !== undefined ? Mode.AuthPsk : Mode.Psk;
      } else {
        mode = params.senderKey !== undefined ? Mode.Auth : Mode.Base;
      }
      return await this._keyScheduleS(mode, dh.sharedSecret, dh.enc, params);
    }
    async createRecipientContext(params) {
      this._validateInputLength(params);
      await this._setup();
      const sharedSecret = await this._kem.decap(params);
      let mode;
      if (params.psk !== undefined) {
        mode = params.senderPublicKey !== undefined ? Mode.AuthPsk : Mode.Psk;
      } else {
        mode = params.senderPublicKey !== undefined ? Mode.Auth : Mode.Base;
      }
      return await this._keyScheduleR(mode, sharedSecret, params);
    }
    async seal(params, pt, aad = EMPTY.buffer) {
      const ctx = await this.createSenderContext(params);
      return {
        ct: await ctx.seal(pt, aad),
        enc: ctx.enc,
      };
    }
    async open(params, ct, aad = EMPTY.buffer) {
      const ctx = await this.createRecipientContext(params);
      return await ctx.open(ct, aad);
    }
    async _keySchedule(mode, sharedSecret, params) {
      const pskId = params.psk === undefined ? EMPTY : toUint8Array(params.psk.id);
      const pskIdHash = await this._kdf.labeledExtract(EMPTY, LABEL_PSK_ID_HASH, pskId);
      const info = params.info === undefined ? EMPTY : toUint8Array(params.info);
      const infoHash = await this._kdf.labeledExtract(EMPTY, LABEL_INFO_HASH, info);
      const keyScheduleContext = new Uint8Array(1 + pskIdHash.byteLength + infoHash.byteLength);
      keyScheduleContext.set(new Uint8Array([mode]), 0);
      keyScheduleContext.set(new Uint8Array(pskIdHash), 1);
      keyScheduleContext.set(new Uint8Array(infoHash), 1 + pskIdHash.byteLength);
      const psk = params.psk === undefined ? EMPTY : toUint8Array(params.psk.key);
      const ikm = this._kdf.buildLabeledIkm(LABEL_SECRET, psk);
      const exporterSecretInfo = this._kdf.buildLabeledInfo(
        LABEL_EXP,
        keyScheduleContext,
        this._kdf.hashSize,
      );
      const exporterSecret = await this._kdf.extractAndExpand(
        sharedSecret,
        ikm,
        exporterSecretInfo,
        this._kdf.hashSize,
      );
      if (this._aead.id === AeadId.ExportOnly) {
        return { aead: this._aead, exporterSecret };
      }
      const keyInfo = this._kdf.buildLabeledInfo(LABEL_KEY, keyScheduleContext, this._aead.keySize);
      const key = await this._kdf.extractAndExpand(sharedSecret, ikm, keyInfo, this._aead.keySize);
      const baseNonceInfo = this._kdf.buildLabeledInfo(
        LABEL_BASE_NONCE,
        keyScheduleContext,
        this._aead.nonceSize,
      );
      const baseNonce = await this._kdf.extractAndExpand(
        sharedSecret,
        ikm,
        baseNonceInfo,
        this._aead.nonceSize,
      );
      return {
        aead: this._aead,
        exporterSecret,
        key,
        baseNonce: new Uint8Array(baseNonce),
        seq: 0,
      };
    }
    async _keyScheduleS(mode, sharedSecret, enc, params) {
      const res = await this._keySchedule(mode, sharedSecret, params);
      if (res.key === undefined) {
        return new SenderExporterContextImpl(this._api, this._kdf, res.exporterSecret, enc);
      }
      return new SenderContextImpl(this._api, this._kdf, res, enc);
    }
    async _keyScheduleR(mode, sharedSecret, params) {
      const res = await this._keySchedule(mode, sharedSecret, params);
      if (res.key === undefined) {
        return new RecipientExporterContextImpl(this._api, this._kdf, res.exporterSecret);
      }
      return new RecipientContextImpl(this._api, this._kdf, res);
    }
    _validateInputLength(params) {
      if (params.info !== undefined && params.info.byteLength > INFO_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long info");
      }
      if (params.psk !== undefined) {
        if (params.psk.key.byteLength < MINIMUM_PSK_LENGTH) {
          throw new InvalidParamError(`PSK must have at least ${MINIMUM_PSK_LENGTH} bytes`);
        }
        if (params.psk.key.byteLength > INPUT_LENGTH_LIMIT) {
          throw new InvalidParamError("Too long psk.key");
        }
        if (params.psk.id.byteLength > INPUT_LENGTH_LIMIT) {
          throw new InvalidParamError("Too long psk.id");
        }
      }
      return;
    }
  }

  // node_modules/@hpke/core/esm/src/native.js
  class CipherSuite extends CipherSuiteNative {}
  class HkdfSha256 extends HkdfSha256Native {}
  // node_modules/@hpke/core/esm/src/kems/dhkemPrimitives/x25519.js
  var ALG_NAME = "X25519";
  var PKCS8_ALG_ID_X25519 = new Uint8Array([
    48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 110, 4, 34, 4, 32,
  ]);
  var BASE_POINT_X25519 = /* @__PURE__ */ (() => {
    const p = new Uint8Array(32);
    p[0] = 9;
    return p;
  })();

  class X25519 extends NativeAlgorithm {
    constructor(hkdf) {
      super();
      Object.defineProperty(this, "_hkdf", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_alg", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_nPk", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_nSk", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_nDh", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      Object.defineProperty(this, "_pkcs8AlgId", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: undefined,
      });
      this._alg = { name: ALG_NAME };
      this._hkdf = hkdf;
      this._nPk = 32;
      this._nSk = 32;
      this._nDh = 32;
      this._pkcs8AlgId = PKCS8_ALG_ID_X25519;
    }
    async serializePublicKey(key) {
      await this._setup();
      try {
        return await this._api.exportKey("raw", key);
      } catch (e) {
        throw new SerializeError(e);
      }
    }
    async deserializePublicKey(key) {
      await this._setup();
      try {
        return await this._importRawKey(toArrayBuffer(key), true);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async serializePrivateKey(key) {
      await this._setup();
      try {
        const jwk = await this._api.exportKey("jwk", key);
        if (!("d" in jwk)) {
          throw new Error("Not private key");
        }
        return base64UrlToBytes(jwk["d"]).buffer;
      } catch (e) {
        throw new SerializeError(e);
      }
    }
    async deserializePrivateKey(key) {
      await this._setup();
      try {
        return await this._importRawKey(toArrayBuffer(key), false);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async importKey(format, key, isPublic) {
      await this._setup();
      try {
        if (format === "raw") {
          return await this._importRawKey(key, isPublic);
        }
        if (key instanceof ArrayBuffer) {
          throw new Error("Invalid jwk key format");
        }
        return await this._importJWK(key, isPublic);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
    async generateKeyPair() {
      await this._setup();
      try {
        return await this._api.generateKey(ALG_NAME, true, KEM_USAGES);
      } catch (e) {
        throw new NotSupportedError(e);
      }
    }
    async deriveKeyPair(ikm) {
      await this._setup();
      try {
        const rawIkm = toArrayBuffer(ikm);
        const dkpPrk = await this._hkdf.labeledExtract(
          EMPTY,
          LABEL_DKP_PRK,
          new Uint8Array(rawIkm),
        );
        const rawSk = await this._hkdf.labeledExpand(dkpPrk, LABEL_SK, EMPTY, this._nSk);
        const rawSkBytes = new Uint8Array(rawSk);
        const sk = await this._deserializePkcs8Key(rawSkBytes);
        rawSkBytes.fill(0);
        return {
          privateKey: sk,
          publicKey: await this.derivePublicKey(sk),
        };
      } catch (e) {
        throw new DeriveKeyPairError(e);
      }
    }
    async derivePublicKey(key) {
      await this._setup();
      try {
        const jwk = await this._api.exportKey("jwk", key);
        delete jwk["d"];
        delete jwk["key_ops"];
        return await this._api.importKey("jwk", jwk, this._alg, true, []);
      } catch {
        try {
          const bp = await this._api.importKey(
            "raw",
            BASE_POINT_X25519.buffer,
            this._alg,
            true,
            [],
          );
          const bits = await this._api.deriveBits(
            {
              name: ALG_NAME,
              public: bp,
            },
            key,
            this._nPk * 8,
          );
          return await this._api.importKey("raw", bits, this._alg, true, []);
        } catch (e) {
          throw new DeserializeError(e);
        }
      }
    }
    async dh(sk, pk) {
      await this._setup();
      try {
        const bits = await this._api.deriveBits(
          {
            name: ALG_NAME,
            public: pk,
          },
          sk,
          this._nDh * 8,
        );
        return bits;
      } catch (e) {
        throw new SerializeError(e);
      }
    }
    async _importRawKey(key, isPublic) {
      if (isPublic && key.byteLength !== this._nPk) {
        throw new Error("Invalid public key for the ciphersuite");
      }
      if (!isPublic && key.byteLength !== this._nSk) {
        throw new Error("Invalid private key for the ciphersuite");
      }
      if (isPublic) {
        return await this._api.importKey("raw", key, this._alg, true, []);
      }
      return await this._deserializePkcs8Key(new Uint8Array(key));
    }
    async _importJWK(key, isPublic) {
      if (typeof key.kty === "undefined" || key.kty !== "OKP") {
        throw new Error(`Invalid kty: ${key.crv}`);
      }
      if (typeof key.crv === "undefined" || key.crv !== ALG_NAME) {
        throw new Error(`Invalid crv: ${key.crv}`);
      }
      if (isPublic) {
        if (typeof key.d !== "undefined") {
          throw new Error("Invalid key: `d` should not be set");
        }
        return await this._api.importKey("jwk", key, this._alg, true, []);
      }
      if (typeof key.d === "undefined") {
        throw new Error("Invalid key: `d` not found");
      }
      return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
    }
    async _deserializePkcs8Key(k) {
      const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
      pkcs8Key.set(this._pkcs8AlgId, 0);
      pkcs8Key.set(k, this._pkcs8AlgId.length);
      return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
    }
  }

  // node_modules/@hpke/core/esm/src/kems/dhkemX25519.js
  class DhkemX25519HkdfSha256 extends Dhkem {
    constructor() {
      const kdf = new HkdfSha256Native();
      super(KemId.DhkemX25519HkdfSha256, new X25519(kdf), kdf);
      Object.defineProperty(this, "id", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: KemId.DhkemX25519HkdfSha256,
      });
      Object.defineProperty(this, "secretSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32,
      });
      Object.defineProperty(this, "encSize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32,
      });
      Object.defineProperty(this, "publicKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32,
      });
      Object.defineProperty(this, "privateKeySize", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: 32,
      });
    }
  }
  // client/e2ee/src/crypto.ts
  var ALGORITHM = "x25519-hpke-aes256gcm-ed25519";
  var suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
  var subtle = () => crypto.subtle;
  var generateSigningKey = () =>
    subtle().generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  var generateAgreementKey = () => subtle().generateKey({ name: "X25519" }, false, ["deriveBits"]);
  var exportPublic = async (key) => toB64u(await subtle().exportKey("raw", key));
  var sign = async (key, message) =>
    toB64u(await subtle().sign({ name: "Ed25519" }, key, utf8(message)));
  var verify = async (publicKey, message, signature) => {
    try {
      const raw = fromB64u(publicKey);
      const sig = fromB64u(signature);
      if (raw.length !== 32 || sig.length !== 64) return false;
      const key = await subtle().importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      return await subtle().verify({ name: "Ed25519" }, key, sig, utf8(message));
    } catch {
      return false;
    }
  };
  var deviceIdFor = async (signingKey) =>
    toB64u((await sha256(fromB64u(signingKey))).subarray(0, 16));
  var hpkeSeal = async (recipientPublic, plaintext, info, aad) => {
    const recipientPublicKey = await suite.kem.deserializePublicKey(fromB64u(recipientPublic));
    const { ct, enc } = await suite.seal(
      { recipientPublicKey, info: utf8(info) },
      plaintext,
      utf8(aad),
    );
    return { enc: toB64u(enc), wrapped: toB64u(ct) };
  };
  var hpkeOpen = async (recipientKey, enc, wrapped, info, aad) =>
    new Uint8Array(
      await suite.open(
        { recipientKey, enc: fromB64u(enc), info: utf8(info) },
        fromB64u(wrapped),
        utf8(aad),
      ),
    );
  var aesKey = (raw, usage) => subtle().importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
  var aesEncrypt = async (raw, iv, plaintext, aad) =>
    new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv, additionalData: utf8(aad) },
        await aesKey(raw, "encrypt"),
        plaintext,
      ),
    );
  var aesDecrypt = async (raw, iv, ciphertext, aad) =>
    new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv, additionalData: utf8(aad) },
        await aesKey(raw, "decrypt"),
        ciphertext,
      ),
    );
  var generateExportable = async (name) => {
    const pair = await subtle().generateKey(
      { name },
      true,
      name === "Ed25519" ? ["sign", "verify"] : ["deriveBits"],
    );
    const { kty, crv, x, d } = await subtle().exportKey("jwk", pair.privateKey);
    return { kty, crv, x, d };
  };
  var importSigningJwk = (jwk) =>
    subtle().importKey("jwk", { ...jwk, key_ops: ["sign"] }, { name: "Ed25519" }, false, ["sign"]);
  var importAgreementJwk = async (jwk) => ({
    privateKey: await subtle().importKey(
      "jwk",
      { ...jwk, key_ops: ["deriveBits"] },
      { name: "X25519" },
      false,
      ["deriveBits"],
    ),
    publicKey: await subtle().importKey("raw", fromB64u(jwk.x), { name: "X25519" }, true, []),
  });
  var x25519 = async (privateKey, publicKey) => {
    const peer = await subtle().importKey(
      "raw",
      fromB64u(publicKey),
      { name: "X25519" },
      false,
      [],
    );
    return new Uint8Array(
      await subtle().deriveBits({ name: "X25519", public: peer }, privateKey, 256),
    );
  };
  var hkdf = async (ikm, salt, info) => {
    const base = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(
      await subtle().deriveBits(
        { name: "HKDF", hash: "SHA-256", salt, info: utf8(info) },
        base,
        256,
      ),
    );
  };
  var sealBox = async (key, plaintext, aad) => {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ct = await aesEncrypt(key, iv, plaintext, aad);
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return toB64u(out);
  };
  var openBox = (key, box, aad) => {
    const raw = fromB64u(box);
    if (raw.length < 28) throw new Error("box too short");
    return aesDecrypt(key, raw.slice(0, 12), raw.slice(12), aad);
  };
  var rotationMessage = (userId, previousKey, nextKey) => `fosscord-e2ee/v1/identity-rotate
${userId}
${previousKey}
${nextKey}`;
  var backupKeyMessage = (userId, publicKey) => `fosscord-e2ee/v1/backup-key
${userId}
${publicKey}`;
  var deviceMessage = (userId, deviceId, signingKey) => `fosscord-e2ee/v1/device
${userId}
${deviceId}
${signingKey}`;
  var prekeyMessage = (deviceId, prekeyId, publicKey) => `fosscord-e2ee/v1/prekey
${deviceId}
${prekeyId}
${publicKey}`;

  // node_modules/hash-wasm/dist/index.esm.js
  /*!
   * hash-wasm (https://www.npmjs.com/package/hash-wasm)
   * (c) Dani Biro
   * @license MIT
   */
  function __awaiter(thisArg, _arguments, P, generator) {
    function adopt(value) {
      return value instanceof P
        ? value
        : new P(function (resolve) {
            resolve(value);
          });
    }
    return new (P || (P = Promise))(function (resolve, reject) {
      function fulfilled(value) {
        try {
          step(generator.next(value));
        } catch (e) {
          reject(e);
        }
      }
      function rejected(value) {
        try {
          step(generator["throw"](value));
        } catch (e) {
          reject(e);
        }
      }
      function step(result) {
        result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
      }
      step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
  }
  class Mutex2 {
    constructor() {
      this.mutex = Promise.resolve();
    }
    lock() {
      let begin = () => {};
      this.mutex = this.mutex.then(() => new Promise(begin));
      return new Promise((res) => {
        begin = res;
      });
    }
    dispatch(fn) {
      return __awaiter(this, undefined, undefined, function* () {
        const unlock = yield this.lock();
        try {
          return yield Promise.resolve(fn());
        } finally {
          unlock();
        }
      });
    }
  }
  var _a;
  function getGlobal() {
    if (typeof globalThis !== "undefined") return globalThis;
    if (typeof self !== "undefined") return self;
    if (typeof window !== "undefined") return window;
    return global;
  }
  var globalObject = getGlobal();
  var nodeBuffer = (_a = globalObject.Buffer) !== null && _a !== undefined ? _a : null;
  var textEncoder = globalObject.TextEncoder ? new globalObject.TextEncoder() : null;
  function hexCharCodesToInt(a, b) {
    return (
      (((a & 15) + ((a >> 6) | ((a >> 3) & 8))) << 4) | ((b & 15) + ((b >> 6) | ((b >> 3) & 8)))
    );
  }
  function writeHexToUInt8(buf, str) {
    const size = str.length >> 1;
    for (let i = 0; i < size; i++) {
      const index = i << 1;
      buf[i] = hexCharCodesToInt(str.charCodeAt(index), str.charCodeAt(index + 1));
    }
  }
  function hexStringEqualsUInt8(str, buf) {
    if (str.length !== buf.length * 2) {
      return false;
    }
    for (let i = 0; i < buf.length; i++) {
      const strIndex = i << 1;
      if (buf[i] !== hexCharCodesToInt(str.charCodeAt(strIndex), str.charCodeAt(strIndex + 1))) {
        return false;
      }
    }
    return true;
  }
  var alpha = 97 - 10;
  var digit = 48;
  function getDigestHex(tmpBuffer, input, hashLength) {
    let p = 0;
    for (let i = 0; i < hashLength; i++) {
      let nibble = input[i] >>> 4;
      tmpBuffer[p++] = nibble > 9 ? nibble + alpha : nibble + digit;
      nibble = input[i] & 15;
      tmpBuffer[p++] = nibble > 9 ? nibble + alpha : nibble + digit;
    }
    return String.fromCharCode.apply(null, tmpBuffer);
  }
  var getUInt8Buffer =
    nodeBuffer !== null
      ? (data) => {
          if (typeof data === "string") {
            const buf = nodeBuffer.from(data, "utf8");
            return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
          }
          if (nodeBuffer.isBuffer(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.length);
          }
          if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }
          throw new Error("Invalid data type!");
        }
      : (data) => {
          if (typeof data === "string") {
            return textEncoder.encode(data);
          }
          if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }
          throw new Error("Invalid data type!");
        };
  var base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var base64Lookup = new Uint8Array(256);
  for (let i = 0; i < base64Chars.length; i++) {
    base64Lookup[base64Chars.charCodeAt(i)] = i;
  }
  function encodeBase64(data, pad = true) {
    const len = data.length;
    const extraBytes = len % 3;
    const parts = [];
    const len2 = len - extraBytes;
    for (let i = 0; i < len2; i += 3) {
      const tmp = ((data[i] << 16) & 16711680) + ((data[i + 1] << 8) & 65280) + (data[i + 2] & 255);
      const triplet =
        base64Chars.charAt((tmp >> 18) & 63) +
        base64Chars.charAt((tmp >> 12) & 63) +
        base64Chars.charAt((tmp >> 6) & 63) +
        base64Chars.charAt(tmp & 63);
      parts.push(triplet);
    }
    if (extraBytes === 1) {
      const tmp = data[len - 1];
      const a = base64Chars.charAt(tmp >> 2);
      const b = base64Chars.charAt((tmp << 4) & 63);
      parts.push(`${a}${b}`);
      if (pad) {
        parts.push("==");
      }
    } else if (extraBytes === 2) {
      const tmp = (data[len - 2] << 8) + data[len - 1];
      const a = base64Chars.charAt(tmp >> 10);
      const b = base64Chars.charAt((tmp >> 4) & 63);
      const c = base64Chars.charAt((tmp << 2) & 63);
      parts.push(`${a}${b}${c}`);
      if (pad) {
        parts.push("=");
      }
    }
    return parts.join("");
  }
  function getDecodeBase64Length(data) {
    let bufferLength = Math.floor(data.length * 0.75);
    const len = data.length;
    if (data[len - 1] === "=") {
      bufferLength -= 1;
      if (data[len - 2] === "=") {
        bufferLength -= 1;
      }
    }
    return bufferLength;
  }
  function decodeBase64(data) {
    const bufferLength = getDecodeBase64Length(data);
    const len = data.length;
    const bytes = new Uint8Array(bufferLength);
    let p = 0;
    for (let i = 0; i < len; i += 4) {
      const encoded1 = base64Lookup[data.charCodeAt(i)];
      const encoded2 = base64Lookup[data.charCodeAt(i + 1)];
      const encoded3 = base64Lookup[data.charCodeAt(i + 2)];
      const encoded4 = base64Lookup[data.charCodeAt(i + 3)];
      bytes[p] = (encoded1 << 2) | (encoded2 >> 4);
      p += 1;
      bytes[p] = ((encoded2 & 15) << 4) | (encoded3 >> 2);
      p += 1;
      bytes[p] = ((encoded3 & 3) << 6) | (encoded4 & 63);
      p += 1;
    }
    return bytes;
  }
  var MAX_HEAP = 16 * 1024;
  var WASM_FUNC_HASH_LENGTH = 4;
  var wasmMutex = new Mutex2();
  var wasmModuleCache = new Map();
  function WASMInterface(binary, hashLength) {
    return __awaiter(this, undefined, undefined, function* () {
      let wasmInstance = null;
      let memoryView = null;
      let initialized = false;
      if (typeof WebAssembly === "undefined") {
        throw new Error("WebAssembly is not supported in this environment!");
      }
      const writeMemory = (data, offset = 0) => {
        memoryView.set(data, offset);
      };
      const getMemory = () => memoryView;
      const getExports = () => wasmInstance.exports;
      const setMemorySize = (totalSize) => {
        wasmInstance.exports.Hash_SetMemorySize(totalSize);
        const arrayOffset = wasmInstance.exports.Hash_GetBuffer();
        const memoryBuffer = wasmInstance.exports.memory.buffer;
        memoryView = new Uint8Array(memoryBuffer, arrayOffset, totalSize);
      };
      const getStateSize = () => {
        const view = new DataView(wasmInstance.exports.memory.buffer);
        const stateSize = view.getUint32(wasmInstance.exports.STATE_SIZE, true);
        return stateSize;
      };
      const loadWASMPromise = wasmMutex.dispatch(() =>
        __awaiter(this, undefined, undefined, function* () {
          if (!wasmModuleCache.has(binary.name)) {
            const asm = decodeBase64(binary.data);
            const promise = WebAssembly.compile(asm);
            wasmModuleCache.set(binary.name, promise);
          }
          const module = yield wasmModuleCache.get(binary.name);
          wasmInstance = yield WebAssembly.instantiate(module, {});
        }),
      );
      const setupInterface = () =>
        __awaiter(this, undefined, undefined, function* () {
          if (!wasmInstance) {
            yield loadWASMPromise;
          }
          const arrayOffset = wasmInstance.exports.Hash_GetBuffer();
          const memoryBuffer = wasmInstance.exports.memory.buffer;
          memoryView = new Uint8Array(memoryBuffer, arrayOffset, MAX_HEAP);
        });
      const init = (bits = null) => {
        initialized = true;
        wasmInstance.exports.Hash_Init(bits);
      };
      const updateUInt8Array = (data) => {
        let read = 0;
        while (read < data.length) {
          const chunk = data.subarray(read, read + MAX_HEAP);
          read += chunk.length;
          memoryView.set(chunk);
          wasmInstance.exports.Hash_Update(chunk.length);
        }
      };
      const update = (data) => {
        if (!initialized) {
          throw new Error("update() called before init()");
        }
        const Uint8Buffer = getUInt8Buffer(data);
        updateUInt8Array(Uint8Buffer);
      };
      const digestChars = new Uint8Array(hashLength * 2);
      const digest = (outputType, padding = null) => {
        if (!initialized) {
          throw new Error("digest() called before init()");
        }
        initialized = false;
        wasmInstance.exports.Hash_Final(padding);
        if (outputType === "binary") {
          return memoryView.slice(0, hashLength);
        }
        return getDigestHex(digestChars, memoryView, hashLength);
      };
      const save = () => {
        if (!initialized) {
          throw new Error("save() can only be called after init() and before digest()");
        }
        const stateOffset = wasmInstance.exports.Hash_GetState();
        const stateLength = getStateSize();
        const memoryBuffer = wasmInstance.exports.memory.buffer;
        const internalState = new Uint8Array(memoryBuffer, stateOffset, stateLength);
        const prefixedState = new Uint8Array(WASM_FUNC_HASH_LENGTH + stateLength);
        writeHexToUInt8(prefixedState, binary.hash);
        prefixedState.set(internalState, WASM_FUNC_HASH_LENGTH);
        return prefixedState;
      };
      const load = (state) => {
        if (!(state instanceof Uint8Array)) {
          throw new Error("load() expects an Uint8Array generated by save()");
        }
        const stateOffset = wasmInstance.exports.Hash_GetState();
        const stateLength = getStateSize();
        const overallLength = WASM_FUNC_HASH_LENGTH + stateLength;
        const memoryBuffer = wasmInstance.exports.memory.buffer;
        if (state.length !== overallLength) {
          throw new Error(
            `Bad state length (expected ${overallLength} bytes, got ${state.length})`,
          );
        }
        if (!hexStringEqualsUInt8(binary.hash, state.subarray(0, WASM_FUNC_HASH_LENGTH))) {
          throw new Error("This state was written by an incompatible hash implementation");
        }
        const internalState = state.subarray(WASM_FUNC_HASH_LENGTH);
        new Uint8Array(memoryBuffer, stateOffset, stateLength).set(internalState);
        initialized = true;
      };
      const isDataShort = (data) => {
        if (typeof data === "string") {
          return data.length < MAX_HEAP / 4;
        }
        return data.byteLength < MAX_HEAP;
      };
      let canSimplify = isDataShort;
      switch (binary.name) {
        case "argon2":
        case "scrypt":
          canSimplify = () => true;
          break;
        case "blake2b":
        case "blake2s":
          canSimplify = (data, initParam) => initParam <= 512 && isDataShort(data);
          break;
        case "blake3":
          canSimplify = (data, initParam) => initParam === 0 && isDataShort(data);
          break;
        case "xxhash64":
        case "xxhash3":
        case "xxhash128":
        case "crc64":
          canSimplify = () => false;
          break;
      }
      const calculate = (data, initParam = null, digestParam = null) => {
        if (!canSimplify(data, initParam)) {
          init(initParam);
          update(data);
          return digest("hex", digestParam);
        }
        const buffer = getUInt8Buffer(data);
        memoryView.set(buffer);
        wasmInstance.exports.Hash_Calculate(buffer.length, initParam, digestParam);
        return getDigestHex(digestChars, memoryView, hashLength);
      };
      yield setupInterface();
      return {
        getMemory,
        writeMemory,
        getExports,
        setMemorySize,
        init,
        update,
        digest,
        save,
        load,
        calculate,
        hashLength,
      };
    });
  }
  var mutex$l = new Mutex2();
  var name$k = "argon2";
  var data$k =
    "AGFzbQEAAAABKQVgAX8Bf2AAAX9gEH9/f39/f39/f39/f39/f38AYAR/f39/AGACf38AAwYFAAECAwQFBgEBAoCAAgYIAX8BQZCoBAsHQQQGbWVtb3J5AgASSGFzaF9TZXRNZW1vcnlTaXplAAAOSGFzaF9HZXRCdWZmZXIAAQ5IYXNoX0NhbGN1bGF0ZQAECvEyBVgBAn9BACEBAkAgAEEAKAKICCICRg0AAkAgACACayIAQRB2IABBgIB8cSAASWoiAEAAQX9HDQBB/wHADwtBACEBQQBBACkDiAggAEEQdK18NwOICAsgAcALcAECfwJAQQAoAoAIIgANAEEAPwBBEHQiADYCgAhBACgCiAgiAUGAgCBGDQACQEGAgCAgAWsiAEEQdiAAQYCAfHEgAElqIgBAAEF/Rw0AQQAPC0EAQQApA4gIIABBEHStfDcDiAhBACgCgAghAAsgAAvcDgECfiAAIAQpAwAiECAAKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAMIBAgDCkDAIVCIIkiEDcDACAIIBAgCCkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgBCAQIAQpAwCFQiiJIhA3AwAgACAQIAApAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIAwgECAMKQMAhUIwiSIQNwMAIAggECAIKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAEIBAgBCkDAIVCAYk3AwAgASAFKQMAIhAgASkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgDSAQIA0pAwCFQiCJIhA3AwAgCSAQIAkpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAUgECAFKQMAhUIoiSIQNwMAIAEgECABKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACANIBAgDSkDAIVCMIkiEDcDACAJIBAgCSkDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgBSAQIAUpAwCFQgGJNwMAIAIgBikDACIQIAIpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIA4gECAOKQMAhUIgiSIQNwMAIAogECAKKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAGIBAgBikDAIVCKIkiEDcDACACIBAgAikDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgDiAQIA4pAwCFQjCJIhA3AwAgCiAQIAopAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIAYgECAGKQMAhUIBiTcDACADIAcpAwAiECADKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAPIBAgDykDAIVCIIkiEDcDACALIBAgCykDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgByAQIAcpAwCFQiiJIhA3AwAgAyAQIAMpAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIA8gECAPKQMAhUIwiSIQNwMAIAsgECALKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAHIBAgBykDAIVCAYk3AwAgACAFKQMAIhAgACkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgDyAQIA8pAwCFQiCJIhA3AwAgCiAQIAopAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAUgECAFKQMAhUIoiSIQNwMAIAAgECAAKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAPIBAgDykDAIVCMIkiEDcDACAKIBAgCikDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgBSAQIAUpAwCFQgGJNwMAIAEgBikDACIQIAEpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAwgECAMKQMAhUIgiSIQNwMAIAsgECALKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACAGIBAgBikDAIVCKIkiEDcDACABIBAgASkDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgDCAQIAwpAwCFQjCJIhA3AwAgCyAQIAspAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIAYgECAGKQMAhUIBiTcDACACIAcpAwAiECACKQMAIhF8IBFCAYZC/v///x+DIBBC/////w+DfnwiEDcDACANIBAgDSkDAIVCIIkiEDcDACAIIBAgCCkDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgByAQIAcpAwCFQiiJIhA3AwAgAiAQIAIpAwAiEXwgEEL/////D4MgEUIBhkL+////H4N+fCIQNwMAIA0gECANKQMAhUIwiSIQNwMAIAggECAIKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAHIBAgBykDAIVCAYk3AwAgAyAEKQMAIhAgAykDACIRfCARQgGGQv7///8fgyAQQv////8Pg358IhA3AwAgDiAQIA4pAwCFQiCJIhA3AwAgCSAQIAkpAwAiEXwgEUIBhkL+////H4MgEEL/////D4N+fCIQNwMAIAQgECAEKQMAhUIoiSIQNwMAIAMgECADKQMAIhF8IBBC/////w+DIBFCAYZC/v///x+DfnwiEDcDACAOIBAgDikDAIVCMIkiEDcDACAJIBAgCSkDACIRfCAQQv////8PgyARQgGGQv7///8fg358IhA3AwAgBCAQIAQpAwCFQgGJNwMAC98aAQN/QQAhBEEAIAIpAwAgASkDAIU3A5AIQQAgAikDCCABKQMIhTcDmAhBACACKQMQIAEpAxCFNwOgCEEAIAIpAxggASkDGIU3A6gIQQAgAikDICABKQMghTcDsAhBACACKQMoIAEpAyiFNwO4CEEAIAIpAzAgASkDMIU3A8AIQQAgAikDOCABKQM4hTcDyAhBACACKQNAIAEpA0CFNwPQCEEAIAIpA0ggASkDSIU3A9gIQQAgAikDUCABKQNQhTcD4AhBACACKQNYIAEpA1iFNwPoCEEAIAIpA2AgASkDYIU3A/AIQQAgAikDaCABKQNohTcD+AhBACACKQNwIAEpA3CFNwOACUEAIAIpA3ggASkDeIU3A4gJQQAgAikDgAEgASkDgAGFNwOQCUEAIAIpA4gBIAEpA4gBhTcDmAlBACACKQOQASABKQOQAYU3A6AJQQAgAikDmAEgASkDmAGFNwOoCUEAIAIpA6ABIAEpA6ABhTcDsAlBACACKQOoASABKQOoAYU3A7gJQQAgAikDsAEgASkDsAGFNwPACUEAIAIpA7gBIAEpA7gBhTcDyAlBACACKQPAASABKQPAAYU3A9AJQQAgAikDyAEgASkD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";
  var hash$k = "e4cdc523";
  var wasmJson$k = {
    name: name$k,
    data: data$k,
    hash: hash$k,
  };
  var name$j = "blake2b";
  var data$j =
    "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";
  var hash$j = "c6f286e6";
  var wasmJson$j = {
    name: name$j,
    data: data$j,
    hash: hash$j,
  };
  var mutex$k = new Mutex2();
  function validateBits$4(bits) {
    if (!Number.isInteger(bits) || bits < 8 || bits > 512 || bits % 8 !== 0) {
      return new Error("Invalid variant! Valid values: 8, 16, ..., 512");
    }
    return null;
  }
  function getInitParam$1(outputBits, keyBits) {
    return outputBits | (keyBits << 16);
  }
  function createBLAKE2b(bits = 512, key = null) {
    if (validateBits$4(bits)) {
      return Promise.reject(validateBits$4(bits));
    }
    let keyBuffer = null;
    let initParam = bits;
    if (key !== null) {
      keyBuffer = getUInt8Buffer(key);
      if (keyBuffer.length > 64) {
        return Promise.reject(new Error("Max key length is 64 bytes"));
      }
      initParam = getInitParam$1(bits, keyBuffer.length);
    }
    const outputSize = bits / 8;
    return WASMInterface(wasmJson$j, outputSize).then((wasm) => {
      if (initParam > 512) {
        wasm.writeMemory(keyBuffer);
      }
      wasm.init(initParam);
      const obj = {
        init:
          initParam > 512
            ? () => {
                wasm.writeMemory(keyBuffer);
                wasm.init(initParam);
                return obj;
              }
            : () => {
                wasm.init(initParam);
                return obj;
              },
        update: (data) => {
          wasm.update(data);
          return obj;
        },
        digest: (outputType) => wasm.digest(outputType),
        save: () => wasm.save(),
        load: (data) => {
          wasm.load(data);
          return obj;
        },
        blockSize: 128,
        digestSize: outputSize,
      };
      return obj;
    });
  }
  function encodeResult(salt, options, res) {
    const parameters = [
      `m=${options.memorySize}`,
      `t=${options.iterations}`,
      `p=${options.parallelism}`,
    ].join(",");
    return `$argon2${options.hashType}$v=19$${parameters}$${encodeBase64(salt, false)}$${encodeBase64(res, false)}`;
  }
  var uint32View = new DataView(new ArrayBuffer(4));
  function int32LE(x) {
    uint32View.setInt32(0, x, true);
    return new Uint8Array(uint32View.buffer);
  }
  function hashFunc(blake512, buf, len) {
    return __awaiter(this, undefined, undefined, function* () {
      if (len <= 64) {
        const blake = yield createBLAKE2b(len * 8);
        blake.update(int32LE(len));
        blake.update(buf);
        return blake.digest("binary");
      }
      const r = Math.ceil(len / 32) - 2;
      const ret = new Uint8Array(len);
      blake512.init();
      blake512.update(int32LE(len));
      blake512.update(buf);
      let vp = blake512.digest("binary");
      ret.set(vp.subarray(0, 32), 0);
      for (let i = 1; i < r; i++) {
        blake512.init();
        blake512.update(vp);
        vp = blake512.digest("binary");
        ret.set(vp.subarray(0, 32), i * 32);
      }
      const partialBytesNeeded = len - 32 * r;
      let blakeSmall;
      if (partialBytesNeeded === 64) {
        blakeSmall = blake512;
        blakeSmall.init();
      } else {
        blakeSmall = yield createBLAKE2b(partialBytesNeeded * 8);
      }
      blakeSmall.update(vp);
      vp = blakeSmall.digest("binary");
      ret.set(vp.subarray(0, partialBytesNeeded), r * 32);
      return ret;
    });
  }
  function getHashType(type) {
    switch (type) {
      case "d":
        return 0;
      case "i":
        return 1;
      default:
        return 2;
    }
  }
  function argon2Internal(options) {
    return __awaiter(this, undefined, undefined, function* () {
      var _a;
      const { parallelism, iterations, hashLength } = options;
      const password = getUInt8Buffer(options.password);
      const salt = getUInt8Buffer(options.salt);
      const version = 19;
      const hashType = getHashType(options.hashType);
      const { memorySize } = options;
      const secret = getUInt8Buffer((_a = options.secret) !== null && _a !== undefined ? _a : "");
      const [argon2Interface, blake512] = yield Promise.all([
        WASMInterface(wasmJson$k, 1024),
        createBLAKE2b(512),
      ]);
      argon2Interface.setMemorySize(memorySize * 1024 + 1024);
      const initVector = new Uint8Array(24);
      const initVectorView = new DataView(initVector.buffer);
      initVectorView.setInt32(0, parallelism, true);
      initVectorView.setInt32(4, hashLength, true);
      initVectorView.setInt32(8, memorySize, true);
      initVectorView.setInt32(12, iterations, true);
      initVectorView.setInt32(16, version, true);
      initVectorView.setInt32(20, hashType, true);
      argon2Interface.writeMemory(initVector, memorySize * 1024);
      blake512.init();
      blake512.update(initVector);
      blake512.update(int32LE(password.length));
      blake512.update(password);
      blake512.update(int32LE(salt.length));
      blake512.update(salt);
      blake512.update(int32LE(secret.length));
      blake512.update(secret);
      blake512.update(int32LE(0));
      const segments = Math.floor(memorySize / (parallelism * 4));
      const lanes = segments * 4;
      const param = new Uint8Array(72);
      const H0 = blake512.digest("binary");
      param.set(H0);
      for (let lane = 0; lane < parallelism; lane++) {
        param.set(int32LE(0), 64);
        param.set(int32LE(lane), 68);
        let position = lane * lanes;
        let chunk = yield hashFunc(blake512, param, 1024);
        argon2Interface.writeMemory(chunk, position * 1024);
        position += 1;
        param.set(int32LE(1), 64);
        chunk = yield hashFunc(blake512, param, 1024);
        argon2Interface.writeMemory(chunk, position * 1024);
      }
      const C = new Uint8Array(1024);
      writeHexToUInt8(C, argon2Interface.calculate(new Uint8Array([]), memorySize));
      const res = yield hashFunc(blake512, C, hashLength);
      if (options.outputType === "hex") {
        const digestChars = new Uint8Array(hashLength * 2);
        return getDigestHex(digestChars, res, hashLength);
      }
      if (options.outputType === "encoded") {
        return encodeResult(salt, options, res);
      }
      return res;
    });
  }
  var validateOptions$3 = (options) => {
    var _a;
    if (!options || typeof options !== "object") {
      throw new Error("Invalid options parameter. It requires an object.");
    }
    if (!options.password) {
      throw new Error("Password must be specified");
    }
    options.password = getUInt8Buffer(options.password);
    if (options.password.length < 1) {
      throw new Error("Password must be specified");
    }
    if (!options.salt) {
      throw new Error("Salt must be specified");
    }
    options.salt = getUInt8Buffer(options.salt);
    if (options.salt.length < 8) {
      throw new Error("Salt should be at least 8 bytes long");
    }
    options.secret = getUInt8Buffer((_a = options.secret) !== null && _a !== undefined ? _a : "");
    if (!Number.isInteger(options.iterations) || options.iterations < 1) {
      throw new Error("Iterations should be a positive number");
    }
    if (!Number.isInteger(options.parallelism) || options.parallelism < 1) {
      throw new Error("Parallelism should be a positive number");
    }
    if (!Number.isInteger(options.hashLength) || options.hashLength < 4) {
      throw new Error("Hash length should be at least 4 bytes.");
    }
    if (!Number.isInteger(options.memorySize)) {
      throw new Error("Memory size should be specified.");
    }
    if (options.memorySize < 8 * options.parallelism) {
      throw new Error("Memory size should be at least 8 * parallelism.");
    }
    if (options.outputType === undefined) {
      options.outputType = "hex";
    }
    if (!["hex", "binary", "encoded"].includes(options.outputType)) {
      throw new Error(
        `Insupported output type ${options.outputType}. Valid values: ['hex', 'binary', 'encoded']`,
      );
    }
  };
  function argon2id(options) {
    return __awaiter(this, undefined, undefined, function* () {
      validateOptions$3(options);
      return argon2Internal(Object.assign(Object.assign({}, options), { hashType: "id" }));
    });
  }
  var mutex$j = new Mutex2();
  var mutex$i = new Mutex2();
  var mutex$h = new Mutex2();
  var mutex$g = new Mutex2();
  var polyBuffer = new Uint8Array(8);
  var mutex$f = new Mutex2();
  var mutex$e = new Mutex2();
  var mutex$d = new Mutex2();
  var mutex$c = new Mutex2();
  var mutex$b = new Mutex2();
  var mutex$a = new Mutex2();
  var mutex$9 = new Mutex2();
  var mutex$8 = new Mutex2();
  var mutex$7 = new Mutex2();
  var mutex$6 = new Mutex2();
  var mutex$5 = new Mutex2();
  var seedBuffer$2 = new Uint8Array(8);
  var mutex$4 = new Mutex2();
  var seedBuffer$1 = new Uint8Array(8);
  var mutex$3 = new Mutex2();
  var seedBuffer = new Uint8Array(8);
  var mutex$2 = new Mutex2();
  var mutex$1 = new Mutex2();
  var mutex = new Mutex2();

  // client/e2ee/src/backup.ts
  var PASSWORD_KDF = {
    name: "argon2id",
    memory: 65536,
    iterations: 3,
    parallelism: 1,
  };
  var RECOVERY_KDF = { name: "hkdf-sha256" };
  var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  var CODE_LENGTH = 32;
  var generateRecoveryCode = () =>
    (
      [...randomBytes(CODE_LENGTH)]
        .map((byte) => ALPHABET[byte & 31])
        .join("")
        .match(/.{4}/g) ?? []
    ).join("-");
  var normalizeRecoveryCode = (code) =>
    code
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, "")
      .replace(/O/g, "0")
      .replace(/[IL]/g, "1");
  var derived = new Map();
  var deriveBackupKey = (kdf, salt, input) => {
    const cacheKey = `${kdf.name}|${kdf.memory}|${kdf.iterations}|${salt}|${input}`;
    let pending = derived.get(cacheKey);
    if (!pending) {
      pending =
        kdf.name === "argon2id"
          ? argon2id({
              password: utf8(input),
              salt: fromB64u(salt),
              parallelism: kdf.parallelism ?? 1,
              iterations: kdf.iterations ?? 3,
              memorySize: kdf.memory ?? 65536,
              hashLength: 32,
              outputType: "binary",
            }).then((bytes) => new Uint8Array(bytes))
          : hkdf(
              utf8(normalizeRecoveryCode(input)),
              fromB64u(salt),
              "fosscord-e2ee/v1/recovery-code",
            );
      pending.catch(() => derived.delete(cacheKey));
      derived.clear();
      derived.set(cacheKey, pending);
    }
    return pending;
  };
  var secretAad = (userId) => `fosscord-e2ee/v1/backup-secret
${userId}`;
  var wrapSecret = async (userId, mode, input, secret) => {
    const kdf = mode === "password" ? PASSWORD_KDF : RECOVERY_KDF;
    const salt = toB64u(randomBytes(16));
    const key = await deriveBackupKey(kdf, salt, input);
    return { mode, kdf, salt, wrapped_secret: await sealBox(key, secret, secretAad(userId)) };
  };
  var unwrapSecret = async (userId, record, input) => {
    if (!record.wrapped_secret) throw new Error("backup has no wrapped secret");
    const key = await deriveBackupKey(record.kdf, record.salt, input);
    return openBox(key, record.wrapped_secret, secretAad(userId));
  };
  var secretKey = (secret, label) =>
    hkdf(secret, new Uint8Array(32), `fosscord-e2ee/v1/backup/${label}`);
  var sealJwk = async (secret, label, userId, jwk) =>
    sealBox(
      await secretKey(secret, label),
      utf8(JSON.stringify(jwk)),
      `${label}
${userId}`,
    );
  var sealTrust = async (secret, userId, trust) =>
    sealBox(
      await secretKey(secret, "trust"),
      utf8(JSON.stringify(trust)),
      `trust
${userId}`,
    );
  var openTrust = async (secret, userId, box) => {
    const parsed = JSON.parse(
      fromUtf8(
        await openBox(
          await secretKey(secret, "trust"),
          box,
          `trust
${userId}`,
        ),
      ),
    );
    if (!parsed || typeof parsed !== "object") throw new Error("bad trust list in backup");
    const trust = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (
        typeof entry?.key === "string" &&
        typeof entry.verified === "boolean" &&
        typeof entry.at === "number"
      )
        trust[id] = { key: entry.key, verified: entry.verified, at: entry.at };
    }
    return trust;
  };
  var openJwk = async (secret, label, userId, box) => {
    const jwk = JSON.parse(
      fromUtf8(
        await openBox(
          await secretKey(secret, label),
          box,
          `${label}
${userId}`,
        ),
      ),
    );
    if (jwk.kty !== "OKP" || typeof jwk.x !== "string" || typeof jwk.d !== "string")
      throw new Error("bad key in backup");
    return jwk;
  };

  // client/e2ee/src/store.ts
  var database = null;
  var open = () =>
    (database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("fosscord-e2ee", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  var run = async (mode, action) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", mode);
      const request = action(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  var scoped = (userId) => {
    const key = (name) => `${userId}:${name}`;
    return {
      get: (name) => run("readonly", (s) => s.get(key(name))),
      set: (name, value) => run("readwrite", (s) => s.put(value, key(name))),
      del: (name) => run("readwrite", (s) => s.delete(key(name))),
    };
  };
  var grab = (name) => {
    try {
      return window[name] ?? null;
    } catch {
      return null;
    }
  };
  var browserStorage = grab("localStorage");
  var tabStorage = grab("sessionStorage");
  var PENDING_KEY = "fe2ee-pending-password";
  var pendingKey = async () => {
    const existing = await run("readonly", (s) => s.get("pending-password-key"));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    await run("readwrite", (s) => s.put(key, "pending-password-key"));
    return key;
  };
  var holdPendingPassword = async (userId, value) => {
    const iv = randomBytes(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pendingKey(), utf8(value)),
    );
    try {
      tabStorage?.setItem(
        PENDING_KEY,
        JSON.stringify({
          userId,
          at: Date.now(),
          iv: toB64u(iv),
          ct: toB64u(ct),
        }),
      );
    } catch {
      return;
    }
  };
  var takePendingPassword = async (userId, ttl) => {
    let pending = null;
    try {
      pending = JSON.parse(tabStorage?.getItem(PENDING_KEY) ?? "null");
    } catch {
      return null;
    }
    if (!pending || (pending.userId && pending.userId !== userId) || Date.now() - pending.at > ttl)
      return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64u(pending.iv) },
        await pendingKey(),
        fromB64u(pending.ct),
      );
      return { value: fromUtf8(plain), at: pending.at };
    } catch {
      return null;
    }
  };
  var dropPendingPassword = () => {
    try {
      tabStorage?.removeItem(PENDING_KEY);
    } catch {
      return;
    }
  };

  // client/e2ee/src/i18n.ts
  var LOCALES = ["de", "fr", "ja", "pl", "zh-CN"];
  var STRINGS = {
    "Preparing private chat… Your message is still in the text box.": [
      "Privater Chat wird vorbereitet… Deine Nachricht bleibt im Textfeld.",
      "Préparation de la conversation privée… Votre message reste dans le champ de texte.",
      "プライベートチャットを準備中… メッセージは入力欄に残っています。",
      "Przygotowywanie prywatnego czatu… Twoja wiadomość pozostaje w polu tekstowym.",
      "正在准备私密聊天… 你的消息仍保留在输入框中。",
    ],
    "Preparing private chat…": [
      "Privater Chat wird vorbereitet…",
      "Préparation de la conversation privée…",
      "プライベートチャットを準備中…",
      "Przygotowywanie prywatnego czatu…",
      "正在准备私密聊天…",
    ],
    Close: ["Schließen", "Fermer", "閉じる", "Zamknij", "关闭"],
    Cancel: ["Abbrechen", "Annuler", "キャンセル", "Anuluj", "取消"],
    Done: ["Fertig", "OK", "完了", "Gotowe", "完成"],
    Unlock: ["Entsperren", "Déverrouiller", "ロック解除", "Odblokuj", "解锁"],
    Review: ["Prüfen", "Vérifier", "確認する", "Sprawdź", "查看"],
    Remove: ["Entfernen", "Retirer", "削除", "Usuń", "移除"],
    Deny: ["Ablehnen", "Refuser", "拒否", "Odrzuć", "拒绝"],
    "Not now": ["Nicht jetzt", "Pas maintenant", "後で", "Nie teraz", "以后再说"],
    "Back up": ["Sichern", "Sauvegarder", "バックアップ", "Utwórz kopię", "备份"],
    "Someone here": ["Jemand hier", "Quelqu'un ici", "ここにいる誰か", "Ktoś tutaj", "这里有人"],
    Someone: ["Jemand", "Quelqu'un", "誰か", "Ktoś", "某人"],
    "{names} haven't set up encryption yet. Ask them to open the app once, then try again.": [
      "{names} haben die Verschlüsselung noch nicht eingerichtet. Bitte sie, die App einmal zu öffnen, und versuche es dann erneut.",
      "{names} n'ont pas encore configuré le chiffrement. Demande-leur d'ouvrir l'appli une fois, puis réessaie.",
      "{names} はまだ暗号化を設定していません。一度アプリを開いてもらってから、もう一度お試しください。",
      "{names} nie skonfigurowali jeszcze szyfrowania. Poproś ich, żeby raz otworzyli aplikację, i spróbuj ponownie.",
      "{names} 还没有设置加密。请让他们打开一次应用，然后再试一次。",
    ],
    "{name} hasn't set up encryption yet. Ask them to open the app once, then try again.": [
      "{name} hat die Verschlüsselung noch nicht eingerichtet. Bitte die Person, die App einmal zu öffnen, und versuche es dann erneut.",
      "{name} n'a pas encore configuré le chiffrement. Demande-lui d'ouvrir l'appli une fois, puis réessaie.",
      "{name} はまだ暗号化を設定していません。一度アプリを開いてもらってから、もう一度お試しください。",
      "{name} nie skonfigurował(a) jeszcze szyfrowania. Poproś tę osobę, żeby raz otworzyła aplikację, i spróbuj ponownie.",
      "{name} 还没有设置加密。请让对方打开一次应用，然后再试一次。",
    ],
    "Your message couldn't be encrypted, so it wasn't sent.": [
      "Deine Nachricht konnte nicht verschlüsselt werden und wurde daher nicht gesendet.",
      "Ton message n'a pas pu être chiffré, il n'a donc pas été envoyé.",
      "メッセージを暗号化できなかったため、送信されませんでした。",
      "Nie udało się zaszyfrować wiadomości, więc nie została wysłana.",
      "你的消息无法加密，因此没有发送。",
    ],
    "{name} hasn't set up encryption yet, so your message wasn't sent. Ask them to open the app once.":
      [
        "{name} hat die Verschlüsselung noch nicht eingerichtet, daher wurde deine Nachricht nicht gesendet. Bitte die Person, die App einmal zu öffnen.",
        "{name} n'a pas encore configuré le chiffrement, ton message n'a donc pas été envoyé. Demande-lui d'ouvrir l'appli une fois.",
        "{name} がまだ暗号化を設定していないため、メッセージは送信されませんでした。一度アプリを開いてもらってください。",
        "{name} nie skonfigurował(a) jeszcze szyfrowania, więc wiadomość nie została wysłana. Poproś tę osobę, żeby raz otworzyła aplikację.",
        "{name} 还没有设置加密，因此你的消息没有发送。请让对方打开一次应用。",
      ],
    "{name}'s safety number changed. Review it before sending more messages.": [
      "Die Sicherheitsnummer von {name} hat sich geändert. Prüfe sie, bevor du weitere Nachrichten sendest.",
      "Le numéro de sécurité de {name} a changé. Vérifie-le avant d'envoyer d'autres messages.",
      "{name} の安全番号が変更されました。メッセージを送る前に確認してください。",
      "Numer bezpieczeństwa użytkownika {name} się zmienił. Sprawdź go, zanim wyślesz kolejne wiadomości.",
      "{name} 的安全码已更改。请在继续发送消息前查看。",
    ],
    "{reason}. Your message wasn't sent.": [
      "{reason}. Deine Nachricht wurde nicht gesendet.",
      "{reason}. Ton message n'a pas été envoyé.",
      "{reason}。メッセージは送信されませんでした。",
      "{reason}. Wiadomość nie została wysłana.",
      "{reason}。你的消息没有发送。",
    ],
    "Unlock this browser to send encrypted messages. Your message wasn't sent.": [
      "Entsperre diesen Browser, um verschlüsselte Nachrichten zu senden. Deine Nachricht wurde nicht gesendet.",
      "Déverrouille ce navigateur pour envoyer des messages chiffrés. Ton message n'a pas été envoyé.",
      "暗号化されたメッセージを送るには、このブラウザのロックを解除してください。メッセージは送信されませんでした。",
      "Odblokuj tę przeglądarkę, aby wysyłać zaszyfrowane wiadomości. Wiadomość nie została wysłana.",
      "解锁此浏览器后才能发送加密消息。你的消息没有发送。",
    ],
    "End-to-end encryption is unavailable right now, so your message wasn't sent.": [
      "Die Ende-zu-Ende-Verschlüsselung ist gerade nicht verfügbar, daher wurde deine Nachricht nicht gesendet.",
      "Le chiffrement de bout en bout est indisponible pour le moment, ton message n'a donc pas été envoyé.",
      "現在エンドツーエンド暗号化を利用できないため、メッセージは送信されませんでした。",
      "Szyfrowanie end-to-end jest teraz niedostępne, więc wiadomość nie została wysłana.",
      "端到端加密暂时不可用，因此你的消息没有发送。",
    ],
    "Turn on end-to-end encryption?": [
      "Ende-zu-Ende-Verschlüsselung aktivieren?",
      "Activer le chiffrement de bout en bout ?",
      "エンドツーエンド暗号化をオンにしますか？",
      "Włączyć szyfrowanie end-to-end?",
      "开启端到端加密？",
    ],
    "New messages, files and stickers in this conversation are encrypted in your browser before they're sent, and only the people in it can read them. Encryption can't be turned off later.":
      [
        "Neue Nachrichten, Dateien und Sticker in dieser Unterhaltung werden in deinem Browser verschlüsselt, bevor sie gesendet werden, und nur die Personen darin können sie lesen. Die Verschlüsselung kann später nicht mehr deaktiviert werden.",
        "Les nouveaux messages, fichiers et autocollants de cette conversation sont chiffrés dans ton navigateur avant d'être envoyés, et seules les personnes qui y participent peuvent les lire. Le chiffrement ne peut pas être désactivé ensuite.",
        "この会話の新しいメッセージ、ファイル、スタンプは送信前にブラウザで暗号化され、参加しているメンバーだけが読めます。暗号化は後からオフにできません。",
        "Nowe wiadomości, pliki i naklejki w tej rozmowie są szyfrowane w przeglądarce przed wysłaniem i mogą je odczytać tylko jej uczestnicy. Szyfrowania nie można później wyłączyć.",
        "此对话中的新消息、文件和贴纸会在发送前于你的浏览器中加密，只有对话中的人才能阅读。加密开启后无法关闭。",
      ],
    "Polls can't be sent in encrypted conversations.": [
      "In verschlüsselten Unterhaltungen können keine Umfragen gesendet werden.",
      "Les sondages ne peuvent pas être envoyés dans les conversations chiffrées.",
      "暗号化された会話では投票を送信できません。",
      "W szyfrowanych rozmowach nie można wysyłać ankiet.",
      "加密对话中无法发送投票。",
    ],
    "Turn on encryption": [
      "Verschlüsselung aktivieren",
      "Activer le chiffrement",
      "暗号化をオンにする",
      "Włącz szyfrowanie",
      "开启加密",
    ],
    "Safety numbers": [
      "Sicherheitsnummern",
      "Numéros de sécurité",
      "安全番号",
      "Numery bezpieczeństwa",
      "安全码",
    ],
    "Safety number for {name}": [
      "Sicherheitsnummer für {name}",
      "Numéro de sécurité de {name}",
      "{name} の安全番号",
      "Numer bezpieczeństwa: {name}",
      "{name} 的安全码",
    ],
    "Calculating…": ["Wird berechnet …", "Calcul en cours…", "計算中…", "Obliczanie…", "正在计算…"],
    "Safety number changed": [
      "Sicherheitsnummer geändert",
      "Numéro de sécurité modifié",
      "安全番号が変更されました",
      "Numer bezpieczeństwa się zmienił",
      "安全码已更改",
    ],
    Verified: ["Verifiziert", "Vérifié", "認証済み", "Zweryfikowano", "已验证"],
    "Not verified": ["Nicht verifiziert", "Non vérifié", "未認証", "Niezweryfikowano", "未验证"],
    "This person hasn't set up encryption yet.": [
      "Diese Person hat die Verschlüsselung noch nicht eingerichtet.",
      "Cette personne n'a pas encore configuré le chiffrement.",
      "このユーザーはまだ暗号化を設定していません。",
      "Ta osoba nie skonfigurowała jeszcze szyfrowania.",
      "此人还没有设置加密。",
    ],
    "Accept new safety number": [
      "Neue Sicherheitsnummer akzeptieren",
      "Accepter le nouveau numéro de sécurité",
      "新しい安全番号を承認",
      "Zaakceptuj nowy numer bezpieczeństwa",
      "接受新的安全码",
    ],
    "Remove verification": [
      "Verifizierung entfernen",
      "Retirer la vérification",
      "認証を解除",
      "Usuń weryfikację",
      "取消验证",
    ],
    "Mark as verified": [
      "Als verifiziert markieren",
      "Marquer comme vérifié",
      "認証済みにする",
      "Oznacz jako zweryfikowane",
      "标记为已验证",
    ],
    "Encryption settings": [
      "Verschlüsselungseinstellungen",
      "Paramètres de chiffrement",
      "暗号化の設定",
      "Ustawienia szyfrowania",
      "加密设置",
    ],
    "Reset encryption?": [
      "Verschlüsselung zurücksetzen?",
      "Réinitialiser le chiffrement ?",
      "暗号化をリセットしますか？",
      "Zresetować szyfrowanie?",
      "重置加密？",
    ],
    "Your other browsers have to be approved again, and the people you talk to are told that your safety number changed.":
      [
        "Deine anderen Browser müssen erneut bestätigt werden, und deine Gesprächspartner erfahren, dass sich deine Sicherheitsnummer geändert hat.",
        "Tes autres navigateurs devront être approuvés à nouveau, et les personnes avec qui tu discutes seront informées que ton numéro de sécurité a changé.",
        "他のブラウザは再度承認が必要になり、会話相手にはあなたの安全番号が変わったことが通知されます。",
        "Pozostałe przeglądarki trzeba będzie ponownie zatwierdzić, a twoi rozmówcy dowiedzą się, że twój numer bezpieczeństwa się zmienił.",
        "你的其他浏览器需要重新批准，与你聊天的人会收到你的安全码已更改的通知。",
      ],
    "Account password": [
      "Kontopasswort",
      "Mot de passe du compte",
      "アカウントのパスワード",
      "Hasło do konta",
      "账号密码",
    ],
    "Reset encryption": [
      "Verschlüsselung zurücksetzen",
      "Réinitialiser le chiffrement",
      "暗号化をリセット",
      "Zresetuj szyfrowanie",
      "重置加密",
    ],
    "Enter your password.": [
      "Gib dein Passwort ein.",
      "Saisis ton mot de passe.",
      "パスワードを入力してください。",
      "Wpisz hasło.",
      "请输入你的密码。",
    ],
    "Encryption was reset. New messages use your new keys.": [
      "Die Verschlüsselung wurde zurückgesetzt. Neue Nachrichten verwenden deine neuen Schlüssel.",
      "Le chiffrement a été réinitialisé. Les nouveaux messages utilisent tes nouvelles clés.",
      "暗号化をリセットしました。新しいメッセージには新しい鍵が使われます。",
      "Szyfrowanie zostało zresetowane. Nowe wiadomości używają nowych kluczy.",
      "加密已重置。新消息将使用你的新密钥。",
    ],
    "That password isn't right.": [
      "Das Passwort ist falsch.",
      "Ce mot de passe est incorrect.",
      "パスワードが正しくありません。",
      "To hasło jest nieprawidłowe.",
      "密码不正确。",
    ],
    "Couldn't reset encryption. Try again.": [
      "Die Verschlüsselung konnte nicht zurückgesetzt werden. Versuche es erneut.",
      "Impossible de réinitialiser le chiffrement. Réessaie.",
      "暗号化をリセットできませんでした。もう一度お試しください。",
      "Nie udało się zresetować szyfrowania. Spróbuj ponownie.",
      "无法重置加密。请重试。",
    ],
    "Recovery code": [
      "Wiederherstellungscode",
      "Code de récupération",
      "リカバリーコード",
      "Kod odzyskiwania",
      "恢复码",
    ],
    "Enter your recovery code.": [
      "Gib deinen Wiederherstellungscode ein.",
      "Saisis ton code de récupération.",
      "リカバリーコードを入力してください。",
      "Wpisz kod odzyskiwania.",
      "请输入你的恢复码。",
    ],
    "Unlock encrypted messages": [
      "Verschlüsselte Nachrichten entsperren",
      "Déverrouiller les messages chiffrés",
      "暗号化されたメッセージのロックを解除",
      "Odblokuj zaszyfrowane wiadomości",
      "解锁加密消息",
    ],
    "This browser can't read your encrypted messages yet. Bring your keys over with one of these.":
      [
        "Dieser Browser kann deine verschlüsselten Nachrichten noch nicht lesen. Übertrage deine Schlüssel auf eine dieser Arten.",
        "Ce navigateur ne peut pas encore lire tes messages chiffrés. Transfère tes clés avec l'une de ces options.",
        "このブラウザではまだ暗号化されたメッセージを読めません。次のいずれかの方法で鍵を移してください。",
        "Ta przeglądarka nie może jeszcze odczytać twoich zaszyfrowanych wiadomości. Przenieś klucze jednym z tych sposobów.",
        "此浏览器还无法读取你的加密消息。请用以下任一方式转移你的密钥。",
      ],
    "Enter your password": [
      "Passwort eingeben",
      "Saisir ton mot de passe",
      "パスワードを入力",
      "Wpisz hasło",
      "输入你的密码",
    ],
    "If your keys aren't backed up with your password yet, open the app on a browser you used before. It asks for your password once, and then it works here too.":
      [
        "Wenn deine Schlüssel noch nicht mit deinem Passwort gesichert sind, öffne die App in einem Browser, den du schon benutzt hast. Dort wirst du einmal nach deinem Passwort gefragt, danach funktioniert es auch hier.",
        "Si tes clés ne sont pas encore sauvegardées avec ton mot de passe, ouvre l'appli dans un navigateur que tu as déjà utilisé. Il te demandera ton mot de passe une fois, et cela fonctionnera ensuite ici aussi.",
        "鍵がまだパスワードでバックアップされていない場合は、以前使ったブラウザでアプリを開いてください。一度パスワードを求められ、その後はここでも使えるようになります。",
        "Jeśli twoje klucze nie mają jeszcze kopii chronionej hasłem, otwórz aplikację w przeglądarce, której używałeś wcześniej. Raz poprosi o hasło, a potem zadziała też tutaj.",
        "如果你的密钥还没有用密码备份，请在你以前用过的浏览器中打开应用。它会请你输入一次密码，之后这里也能使用。",
      ],
    "Enter your recovery code": [
      "Wiederherstellungscode eingeben",
      "Saisir ton code de récupération",
      "リカバリーコードを入力",
      "Wpisz kod odzyskiwania",
      "输入你的恢复码",
    ],
    "Use the code you saved when you switched to a recovery code.": [
      "Verwende den Code, den du beim Wechsel zu einem Wiederherstellungscode gespeichert hast.",
      "Utilise le code que tu as enregistré lorsque tu es passé à un code de récupération.",
      "リカバリーコードに切り替えたときに保存したコードを使ってください。",
      "Użyj kodu zapisanego przy przejściu na kod odzyskiwania.",
      "使用你切换到恢复码时保存的那个代码。",
    ],
    "Approve from another device": [
      "Von einem anderen Gerät bestätigen",
      "Approuver depuis un autre appareil",
      "別のデバイスから承認",
      "Zatwierdź na innym urządzeniu",
      "从其他设备批准",
    ],
    "Ask for approval": [
      "Bestätigung anfordern",
      "Demander une approbation",
      "承認をリクエスト",
      "Poproś o zatwierdzenie",
      "请求批准",
    ],
    "Lost your code?": [
      "Code verloren?",
      "Code perdu ?",
      "コードをなくしましたか？",
      "Zgubiony kod?",
      "丢失了恢复码？",
    ],
    "Can't unlock this browser?": [
      "Kannst du diesen Browser nicht entsperren?",
      "Impossible de déverrouiller ce navigateur ?",
      "このブラウザのロックを解除できませんか？",
      "Nie możesz odblokować tej przeglądarki?",
      "无法解锁此浏览器？",
    ],
    "If you can't use any of these, reset encryption to keep chatting. Messages sent before the reset can't be read anymore.":
      [
        "Wenn nichts davon geht, setze die Verschlüsselung zurück, um weiterzuchatten. Vor dem Zurücksetzen gesendete Nachrichten können dann nicht mehr gelesen werden.",
        "Si aucune de ces options ne fonctionne, réinitialise le chiffrement pour continuer à discuter. Les messages envoyés avant la réinitialisation ne pourront plus être lus.",
        "どの方法も使えない場合は、暗号化をリセットすれば会話を続けられます。リセット前に送信されたメッセージは読めなくなります。",
        "Jeśli żaden sposób nie działa, zresetuj szyfrowanie, aby dalej rozmawiać. Wiadomości wysłanych przed resetem nie będzie można już odczytać.",
        "如果以上方式都无法使用，可以重置加密以继续聊天。重置前发送的消息将无法再阅读。",
      ],
    "Ask again": [
      "Erneut anfragen",
      "Redemander",
      "もう一度リクエスト",
      "Poproś ponownie",
      "再次请求",
    ],
    "{name} is asking you to approve this browser. Check that it shows this code, then approve it there.":
      [
        "{name} fragt, ob du diesen Browser bestätigen willst. Prüfe, ob dort dieser Code angezeigt wird, und bestätige ihn dann dort.",
        "{name} te demande d'approuver ce navigateur. Vérifie qu'il affiche ce code, puis approuve-le là-bas.",
        "{name} でこのブラウザの承認を求めています。同じコードが表示されていることを確認してから、そちらで承認してください。",
        "{name} prosi o zatwierdzenie tej przeglądarki. Sprawdź, czy wyświetla ten kod, a następnie zatwierdź tam.",
        "{name} 正在请求你批准此浏览器。请确认那边显示的是这个代码，然后在那边批准。",
      ],
    "Your other device": [
      "Dein anderes Gerät",
      "Ton autre appareil",
      "他のデバイス",
      "Twoje inne urządzenie",
      "你的其他设备",
    ],
    "Your other device declined this login.": [
      "Dein anderes Gerät hat diese Anmeldung abgelehnt.",
      "Ton autre appareil a refusé cette connexion.",
      "他のデバイスでこのログインが拒否されました。",
      "Twoje inne urządzenie odrzuciło to logowanie.",
      "你的其他设备拒绝了此次登录。",
    ],
    "The approval didn't unlock this browser. Ask again to retry.": [
      "Die Bestätigung hat diesen Browser nicht entsperrt. Frage erneut an, um es noch einmal zu versuchen.",
      "L'approbation n'a pas déverrouillé ce navigateur. Redemande pour réessayer.",
      "承認してもこのブラウザのロックは解除されませんでした。もう一度リクエストしてください。",
      "Zatwierdzenie nie odblokowało tej przeglądarki. Poproś ponownie, aby spróbować jeszcze raz.",
      "批准没有解锁此浏览器。请再次请求重试。",
    ],
    "Open the app on a browser where you're already signed in. It asks you to approve this one.": [
      "Öffne die App in einem Browser, in dem du bereits angemeldet bist. Dort wirst du gefragt, ob du diesen hier bestätigen willst.",
      "Ouvre l'appli dans un navigateur où tu es déjà connecté. Il te demandera d'approuver celui-ci.",
      "すでにログインしているブラウザでアプリを開いてください。このブラウザの承認を求められます。",
      "Otwórz aplikację w przeglądarce, w której jesteś już zalogowany. Poprosi o zatwierdzenie tej.",
      "在你已登录的浏览器中打开应用，它会请你批准此浏览器。",
    ],
    "Ask a browser where you're already signed in to approve this one.": [
      "Bitte einen Browser, in dem du bereits angemeldet bist, diesen hier zu bestätigen.",
      "Demande à un navigateur où tu es déjà connecté d'approuver celui-ci.",
      "すでにログインしているブラウザに、このブラウザの承認をリクエストします。",
      "Poproś przeglądarkę, w której jesteś już zalogowany, o zatwierdzenie tej.",
      "请已登录的浏览器批准此浏览器。",
    ],
    "This browser is unlocked. Your encrypted messages are loading.": [
      "Dieser Browser ist entsperrt. Deine verschlüsselten Nachrichten werden geladen.",
      "Ce navigateur est déverrouillé. Tes messages chiffrés sont en cours de chargement.",
      "このブラウザのロックを解除しました。暗号化されたメッセージを読み込んでいます。",
      "Ta przeglądarka jest odblokowana. Wczytywanie zaszyfrowanych wiadomości.",
      "此浏览器已解锁，正在加载你的加密消息。",
    ],
    "New login on {name}": [
      "Neue Anmeldung auf {name}",
      "Nouvelle connexion sur {name}",
      "{name} での新しいログイン",
      "Nowe logowanie: {name}",
      "{name} 上的新登录",
    ],
    "Couldn't answer that login: {error}": [
      "Auf diese Anmeldung konnte nicht geantwortet werden: {error}",
      "Impossible de répondre à cette connexion : {error}",
      "このログインに応答できませんでした：{error}",
      "Nie udało się odpowiedzieć na to logowanie: {error}",
      "无法回应此次登录：{error}",
    ],
    "Approve login": [
      "Anmeldung bestätigen",
      "Approuver la connexion",
      "ログインを承認",
      "Zatwierdź logowanie",
      "批准登录",
    ],
    "Back up keys": [
      "Schlüssel sichern",
      "Sauvegarder les clés",
      "鍵をバックアップ",
      "Utwórz kopię kluczy",
      "备份密钥",
    ],
    "Back up your encryption keys": [
      "Sichere deine Schlüssel",
      "Sauvegarde tes clés de chiffrement",
      "暗号鍵をバックアップ",
      "Utwórz kopię kluczy szyfrowania",
      "备份你的加密密钥",
    ],
    "Your encryption keys only exist in this browser right now. Enter your account password to lock a backup of them with it, so any browser you sign in to can read your encrypted messages.":
      [
        "Deine Schlüssel gibt es gerade nur in diesem Browser. Gib dein Kontopasswort ein, um eine damit geschützte Sicherung anzulegen, damit jeder Browser, in dem du dich anmeldest, deine verschlüsselten Nachrichten lesen kann.",
        "Tes clés de chiffrement n'existent pour l'instant que dans ce navigateur. Saisis le mot de passe de ton compte pour en verrouiller une sauvegarde, afin que tout navigateur où tu te connectes puisse lire tes messages chiffrés.",
        "暗号鍵は現在このブラウザにしかありません。アカウントのパスワードを入力して鍵のバックアップをロックすると、ログインしたどのブラウザでも暗号化されたメッセージを読めるようになります。",
        "Twoje klucze szyfrowania istnieją teraz tylko w tej przeglądarce. Wpisz hasło do konta, aby zabezpieczyć nim ich kopię, dzięki czemu każda przeglądarka, w której się zalogujesz, odczyta twoje zaszyfrowane wiadomości.",
        "你的加密密钥目前只存在于此浏览器中。输入账号密码，用它锁定一份密钥备份，这样你登录的任何浏览器都能读取你的加密消息。",
      ],
    "Your encryption keys are backed up.": [
      "Deine Schlüssel sind gesichert.",
      "Tes clés de chiffrement sont sauvegardées.",
      "暗号鍵をバックアップしました。",
      "Utworzono kopię kluczy szyfrowania.",
      "你的加密密钥已备份。",
    ],
    "Use a recovery code": [
      "Wiederherstellungscode verwenden",
      "Utiliser un code de récupération",
      "リカバリーコードを使う",
      "Użyj kodu odzyskiwania",
      "使用恢复码",
    ],
    "We'll make a code that locks your key backup instead of your password. You'll need it to set up a new browser when no other device is around to approve it. We only show it once.":
      [
        "Wir erstellen einen Code, der deine Schlüsselsicherung statt deines Passworts schützt. Du brauchst ihn, um einen neuen Browser einzurichten, wenn kein anderes Gerät ihn bestätigen kann. Er wird nur einmal angezeigt.",
        "Nous allons créer un code qui verrouille la sauvegarde de tes clés à la place de ton mot de passe. Tu en auras besoin pour configurer un nouveau navigateur quand aucun autre appareil ne peut l'approuver. Il n'est affiché qu'une seule fois.",
        "パスワードの代わりに鍵のバックアップをロックするコードを作成します。承認できる他のデバイスがないときに新しいブラウザを設定するために必要です。コードは一度しか表示されません。",
        "Utworzymy kod, który zabezpieczy kopię kluczy zamiast hasła. Będzie potrzebny do skonfigurowania nowej przeglądarki, gdy żadne inne urządzenie nie może jej zatwierdzić. Pokażemy go tylko raz.",
        "我们会生成一个代码，用它代替密码来锁定你的密钥备份。当没有其他设备可以批准时，你需要用它来设置新浏览器。此代码只显示一次。",
      ],
    "Make recovery code": [
      "Wiederherstellungscode erstellen",
      "Créer un code de récupération",
      "リカバリーコードを作成",
      "Utwórz kod odzyskiwania",
      "生成恢复码",
    ],
    "Save this code somewhere safe, like a password manager. Anyone with it and access to your account can read your encrypted messages. It replaces your password lock once you confirm.":
      [
        "Bewahre diesen Code sicher auf, zum Beispiel in einem Passwortmanager. Wer ihn hat und Zugriff auf dein Konto hat, kann deine verschlüsselten Nachrichten lesen. Sobald du bestätigst, ersetzt er den Schutz durch dein Passwort.",
        "Garde ce code en lieu sûr, par exemple dans un gestionnaire de mots de passe. Toute personne qui l'a et a accès à ton compte peut lire tes messages chiffrés. Il remplace le verrouillage par mot de passe dès que tu confirmes.",
        "このコードはパスワードマネージャーなど安全な場所に保存してください。コードとアカウントへのアクセスがあれば、誰でも暗号化されたメッセージを読めます。確認すると、パスワードによるロックがこのコードに置き換わります。",
        "Zapisz ten kod w bezpiecznym miejscu, na przykład w menedżerze haseł. Każdy, kto go ma i ma dostęp do twojego konta, może odczytać twoje zaszyfrowane wiadomości. Po potwierdzeniu zastąpi zabezpieczenie hasłem.",
        "请把此代码保存在安全的地方，例如密码管理器。任何拥有它并能访问你账号的人都能读取你的加密消息。确认后，它将取代密码锁。",
      ],
    "Copy code": ["Code kopieren", "Copier le code", "コードをコピー", "Kopiuj kod", "复制代码"],
    "Copied!": ["Kopiert!", "Copié !", "コピーしました！", "Skopiowano!", "已复制！"],
    "Couldn't copy": [
      "Kopieren fehlgeschlagen",
      "Impossible de copier",
      "コピーできませんでした",
      "Nie udało się skopiować",
      "无法复制",
    ],
    "I saved it": [
      "Ich habe ihn gespeichert",
      "Je l'ai enregistré",
      "保存しました",
      "Zapisałem go",
      "我已保存",
    ],
    "Couldn't switch to the recovery code: {error}": [
      "Wechsel zum Wiederherstellungscode fehlgeschlagen: {error}",
      "Impossible de passer au code de récupération : {error}",
      "リカバリーコードに切り替えられませんでした：{error}",
      "Nie udało się przejść na kod odzyskiwania: {error}",
      "无法切换到恢复码：{error}",
    ],
    "This browser": [
      "Dieser Browser",
      "Ce navigateur",
      "このブラウザ",
      "Ta przeglądarka",
      "此浏览器",
    ],
    "Waiting for approval": [
      "Wartet auf Bestätigung",
      "En attente d'approbation",
      "承認待ち",
      "Oczekuje na zatwierdzenie",
      "等待批准",
    ],
    "Signed out": ["Abgemeldet", "Déconnecté", "ログアウト済み", "Wylogowano", "已退出登录"],
    "Active now": [
      "Gerade aktiv",
      "Actif maintenant",
      "現在アクティブ",
      "Aktywne teraz",
      "当前活跃",
    ],
    "Last active {time}": [
      "Zuletzt aktiv {time}",
      "Dernière activité {time}",
      "最終アクティブ：{time}",
      "Ostatnio aktywne {time}",
      "上次活跃：{time}",
    ],
    "Can read encrypted messages": [
      "Kann verschlüsselte Nachrichten lesen",
      "Peut lire les messages chiffrés",
      "暗号化されたメッセージを読めます",
      "Może odczytywać zaszyfrowane wiadomości",
      "可以读取加密消息",
    ],
    "Added {date}": [
      "Hinzugefügt am {date}",
      "Ajouté le {date}",
      "{date} に追加",
      "Dodano {date}",
      "添加于 {date}",
    ],
    "Remove this device?": [
      "Dieses Gerät entfernen?",
      "Retirer cet appareil ?",
      "このデバイスを削除しますか？",
      "Usunąć to urządzenie?",
      "移除此设备？",
    ],
    "{name} is signed out and can't read new encrypted messages. To read them there again, it needs your recovery code, your password, or approval from another device.":
      [
        "{name} wird abgemeldet und kann keine neuen verschlüsselten Nachrichten mehr lesen. Um sie dort wieder zu lesen, braucht es deinen Wiederherstellungscode, dein Passwort oder die Bestätigung eines anderen Geräts.",
        "{name} sera déconnecté et ne pourra plus lire les nouveaux messages chiffrés. Pour les y lire à nouveau, il faudra ton code de récupération, ton mot de passe ou l'approbation d'un autre appareil.",
        "{name} はログアウトされ、新しい暗号化されたメッセージを読めなくなります。再び読むには、リカバリーコード、パスワード、または別のデバイスからの承認が必要です。",
        "{name} zostanie wylogowane i nie odczyta nowych zaszyfrowanych wiadomości. Aby znów je tam czytać, potrzebny będzie kod odzyskiwania, hasło lub zatwierdzenie na innym urządzeniu.",
        "{name} 将退出登录，并且无法读取新的加密消息。要在那里再次读取，需要你的恢复码、密码或其他设备的批准。",
      ],
    "Remove device": [
      "Gerät entfernen",
      "Retirer l'appareil",
      "デバイスを削除",
      "Usuń urządzenie",
      "移除设备",
    ],
    "Couldn't remove it: {error}": [
      "Entfernen fehlgeschlagen: {error}",
      "Impossible de le retirer : {error}",
      "削除できませんでした：{error}",
      "Nie udało się usunąć: {error}",
      "无法移除：{error}",
    ],
    "Key backup": [
      "Schlüsselsicherung",
      "Sauvegarde des clés",
      "鍵のバックアップ",
      "Kopia kluczy",
      "密钥备份",
    ],
    "Your devices": [
      "Deine Geräte",
      "Tes appareils",
      "あなたのデバイス",
      "Twoje urządzenia",
      "你的设备",
    ],
    "If you lost your recovery code and no other browser can approve a new one, reset encryption to keep chatting. Messages sent before the reset can't be read anymore.":
      [
        "Wenn du deinen Wiederherstellungscode verloren hast und kein anderer Browser einen neuen bestätigen kann, setze die Verschlüsselung zurück, um weiterzuchatten. Vor dem Zurücksetzen gesendete Nachrichten können dann nicht mehr gelesen werden.",
        "Si tu as perdu ton code de récupération et qu'aucun autre navigateur ne peut en approuver un nouveau, réinitialise le chiffrement pour continuer à discuter. Les messages envoyés avant la réinitialisation ne pourront plus être lus.",
        "リカバリーコードをなくし、新しいブラウザを承認できる他のブラウザもない場合は、暗号化をリセットすれば会話を続けられます。リセット前に送信されたメッセージは読めなくなります。",
        "Jeśli zgubiłeś kod odzyskiwania i żadna inna przeglądarka nie może zatwierdzić nowej, zresetuj szyfrowanie, aby dalej rozmawiać. Wiadomości wysłanych przed resetem nie będzie można już odczytać.",
        "如果你丢失了恢复码，并且没有其他浏览器可以批准新浏览器，可以重置加密以继续聊天。重置前发送的消息将无法再阅读。",
      ],
    "Unlocked. This browser can read and send encrypted messages.": [
      "Entsperrt. Dieser Browser kann verschlüsselte Nachrichten lesen und senden.",
      "Déverrouillé. Ce navigateur peut lire et envoyer des messages chiffrés.",
      "ロック解除済み。このブラウザで暗号化されたメッセージを読んだり送ったりできます。",
      "Odblokowano. Ta przeglądarka może odczytywać i wysyłać zaszyfrowane wiadomości.",
      "已解锁。此浏览器可以读取和发送加密消息。",
    ],
    "Locked. This browser can't read encrypted messages yet.": [
      "Gesperrt. Dieser Browser kann noch keine verschlüsselten Nachrichten lesen.",
      "Verrouillé. Ce navigateur ne peut pas encore lire les messages chiffrés.",
      "ロック中。このブラウザではまだ暗号化されたメッセージを読めません。",
      "Zablokowano. Ta przeglądarka nie może jeszcze odczytywać zaszyfrowanych wiadomości.",
      "已锁定。此浏览器还无法读取加密消息。",
    ],
    "Unlock this browser": [
      "Diesen Browser entsperren",
      "Déverrouiller ce navigateur",
      "このブラウザのロックを解除",
      "Odblokuj tę przeglądarkę",
      "解锁此浏览器",
    ],
    "Your keys aren't backed up yet, so new browsers can't read your encrypted messages. Enter your account password to back them up.":
      [
        "Deine Schlüssel sind noch nicht gesichert, daher können neue Browser deine verschlüsselten Nachrichten nicht lesen. Gib dein Kontopasswort ein, um sie zu sichern.",
        "Tes clés ne sont pas encore sauvegardées, les nouveaux navigateurs ne peuvent donc pas lire tes messages chiffrés. Saisis le mot de passe de ton compte pour les sauvegarder.",
        "鍵がまだバックアップされていないため、新しいブラウザでは暗号化されたメッセージを読めません。アカウントのパスワードを入力してバックアップしてください。",
        "Twoje klucze nie mają jeszcze kopii, więc nowe przeglądarki nie odczytają twoich zaszyfrowanych wiadomości. Wpisz hasło do konta, aby utworzyć kopię.",
        "你的密钥还没有备份，因此新浏览器无法读取你的加密消息。输入账号密码来备份它们。",
      ],
    "Your keys aren't backed up yet. Open the app on a browser that can read your messages to back them up.":
      [
        "Deine Schlüssel sind noch nicht gesichert. Öffne die App in einem Browser, der deine Nachrichten lesen kann, um sie zu sichern.",
        "Tes clés ne sont pas encore sauvegardées. Ouvre l'appli dans un navigateur qui peut lire tes messages pour les sauvegarder.",
        "鍵はまだバックアップされていません。メッセージを読めるブラウザでアプリを開いてバックアップしてください。",
        "Twoje klucze nie mają jeszcze kopii. Otwórz aplikację w przeglądarce, która może odczytać twoje wiadomości, aby ją utworzyć.",
        "你的密钥还没有备份。请在能读取你消息的浏览器中打开应用来备份。",
      ],
    "Your keys are backed up and locked with a recovery code. New browsers ask for that code, and your password can't unlock them.":
      [
        "Deine Schlüssel sind gesichert und mit einem Wiederherstellungscode geschützt. Neue Browser fragen nach diesem Code, dein Passwort kann sie nicht entsperren.",
        "Tes clés sont sauvegardées et verrouillées par un code de récupération. Les nouveaux navigateurs demandent ce code, et ton mot de passe ne peut pas les déverrouiller.",
        "鍵はバックアップされ、リカバリーコードでロックされています。新しいブラウザではこのコードが求められ、パスワードではロックを解除できません。",
        "Twoje klucze mają kopię zabezpieczoną kodem odzyskiwania. Nowe przeglądarki poproszą o ten kod, a hasło ich nie odblokuje.",
        "你的密钥已备份并用恢复码锁定。新浏览器会要求输入该代码，密码无法解锁。",
      ],
    "Your keys are backed up and locked with your account password, so new browsers unlock as soon as you sign in. Someone with a copy of the server's database could try to guess a weak password offline.":
      [
        "Deine Schlüssel sind gesichert und mit deinem Kontopasswort geschützt, daher werden neue Browser entsperrt, sobald du dich anmeldest. Wer eine Kopie der Serverdatenbank hat, könnte versuchen, ein schwaches Passwort offline zu erraten.",
        "Tes clés sont sauvegardées et verrouillées par le mot de passe de ton compte, les nouveaux navigateurs se déverrouillent donc dès que tu te connectes. Quelqu'un disposant d'une copie de la base de données du serveur pourrait tenter de deviner un mot de passe faible hors ligne.",
        "鍵はバックアップされ、アカウントのパスワードでロックされているため、新しいブラウザはログインするとすぐにロックが解除されます。サーバーのデータベースのコピーを持つ人は、弱いパスワードをオフラインで推測しようとする可能性があります。",
        "Twoje klucze mają kopię zabezpieczoną hasłem do konta, więc nowe przeglądarki odblokowują się zaraz po zalogowaniu. Ktoś z kopią bazy danych serwera mógłby próbować odgadnąć słabe hasło offline.",
        "你的密钥已备份并用账号密码锁定，因此新浏览器在你登录后会立即解锁。拥有服务器数据库副本的人可能会尝试离线猜测弱密码。",
      ],
    "Your keys are backed up, but they aren't locked with your password yet. Open the app on a browser that can read your messages to finish the backup.":
      [
        "Deine Schlüssel sind gesichert, aber noch nicht mit deinem Passwort geschützt. Öffne die App in einem Browser, der deine Nachrichten lesen kann, um die Sicherung abzuschließen.",
        "Tes clés sont sauvegardées, mais pas encore verrouillées par ton mot de passe. Ouvre l'appli dans un navigateur qui peut lire tes messages pour terminer la sauvegarde.",
        "鍵はバックアップされていますが、まだパスワードでロックされていません。メッセージを読めるブラウザでアプリを開いてバックアップを完了してください。",
        "Twoje klucze mają kopię, ale nie jest jeszcze zabezpieczona hasłem. Otwórz aplikację w przeglądarce, która może odczytać twoje wiadomości, aby dokończyć tworzenie kopii.",
        "你的密钥已备份，但还没有用密码锁定。请在能读取你消息的浏览器中打开应用来完成备份。",
      ],
    "Use a recovery code instead": [
      "Stattdessen Wiederherstellungscode verwenden",
      "Utiliser plutôt un code de récupération",
      "代わりにリカバリーコードを使う",
      "Użyj zamiast tego kodu odzyskiwania",
      "改用恢复码",
    ],
    "Use my password instead": [
      "Stattdessen mein Passwort verwenden",
      "Utiliser plutôt mon mot de passe",
      "代わりにパスワードを使う",
      "Użyj zamiast tego hasła",
      "改用我的密码",
    ],
    "Make a new recovery code": [
      "Neuen Wiederherstellungscode erstellen",
      "Créer un nouveau code de récupération",
      "新しいリカバリーコードを作成",
      "Utwórz nowy kod odzyskiwania",
      "生成新的恢复码",
    ],
    "Unknown browser": [
      "Unbekannter Browser",
      "Navigateur inconnu",
      "不明なブラウザ",
      "Nieznana przeglądarka",
      "未知浏览器",
    ],
    "Encryption is still starting up.": [
      "Die Verschlüsselung wird noch gestartet.",
      "Le chiffrement est en cours de démarrage.",
      "暗号化はまだ起動中です。",
      "Szyfrowanie wciąż się uruchamia.",
      "加密仍在启动中。",
    ],
    "{name}'s safety number changed. Review it before sending. Your message is still in the text box.":
      [
        "Die Sicherheitsnummer von {name} hat sich geändert. Prüfe sie vor dem Senden. Deine Nachricht ist noch im Textfeld.",
        "Le numéro de sécurité de {name} a changé. Vérifie-le avant d'envoyer. Ton message est toujours dans la zone de texte.",
        "{name} の安全番号が変更されました。送信する前に確認してください。メッセージは入力欄に残っています。",
        "Numer bezpieczeństwa użytkownika {name} się zmienił. Sprawdź go przed wysłaniem. Wiadomość nadal jest w polu tekstowym.",
        "{name} 的安全码已更改。请在发送前查看。你的消息仍在输入框中。",
      ],
    "Unlock this browser to send encrypted messages. Your message is still in the text box.": [
      "Entsperre diesen Browser, um verschlüsselte Nachrichten zu senden. Deine Nachricht ist noch im Textfeld.",
      "Déverrouille ce navigateur pour envoyer des messages chiffrés. Ton message est toujours dans la zone de texte.",
      "暗号化されたメッセージを送るには、このブラウザのロックを解除してください。メッセージは入力欄に残っています。",
      "Odblokuj tę przeglądarkę, aby wysyłać zaszyfrowane wiadomości. Wiadomość nadal jest w polu tekstowym.",
      "解锁此浏览器后才能发送加密消息。你的消息仍在输入框中。",
    ],
    Decrypting: ["Wird entschlüsselt", "Déchiffrement", "復号中", "Odszyfrowywanie", "正在解密"],
    "Decrypting…": [
      "Wird entschlüsselt …",
      "Déchiffrement…",
      "復号中…",
      "Odszyfrowywanie…",
      "正在解密…",
    ],
    "Unlock this browser to read this message": [
      "Entsperre diesen Browser, um diese Nachricht zu lesen",
      "Déverrouille ce navigateur pour lire ce message",
      "このメッセージを読むには、このブラウザのロックを解除してください",
      "Odblokuj tę przeglądarkę, aby przeczytać tę wiadomość",
      "解锁此浏览器以阅读这条消息",
    ],
    "This browser doesn't have the key for this message": [
      "Dieser Browser hat den Schlüssel für diese Nachricht nicht",
      "Ce navigateur n'a pas la clé de ce message",
      "このブラウザにはこのメッセージの鍵がありません",
      "Ta przeglądarka nie ma klucza do tej wiadomości",
      "此浏览器没有这条消息的密钥",
    ],
    "Sent before this browser was set up": [
      "Gesendet, bevor dieser Browser eingerichtet wurde",
      "Envoyé avant la configuration de ce navigateur",
      "このブラウザを設定する前に送信されました",
      "Wysłano przed skonfigurowaniem tej przeglądarki",
      "在设置此浏览器之前发送",
    ],
    "Couldn't decrypt: {reason}": [
      "Entschlüsselung fehlgeschlagen: {reason}",
      "Impossible de déchiffrer : {reason}",
      "復号できませんでした：{reason}",
      "Nie udało się odszyfrować: {reason}",
      "无法解密：{reason}",
    ],
    "unknown error": [
      "unbekannter Fehler",
      "erreur inconnue",
      "不明なエラー",
      "nieznany błąd",
      "未知错误",
    ],
    "Get keys": ["Schlüssel holen", "Obtenir les clés", "鍵を取得", "Pobierz klucze", "获取密钥"],
    "Turn On Encryption": [
      "Verschlüsselung aktivieren",
      "Activer le chiffrement",
      "暗号化をオンにする",
      "Włącz szyfrowanie",
      "开启加密",
    ],
    "Safety Number Changed": [
      "Sicherheitsnummer geändert",
      "Numéro de sécurité modifié",
      "安全番号が変更されました",
      "Numer bezpieczeństwa się zmienił",
      "安全码已更改",
    ],
    "Encrypted and Verified": [
      "Verschlüsselt und verifiziert",
      "Chiffré et vérifié",
      "暗号化・認証済み",
      "Zaszyfrowane i zweryfikowane",
      "已加密并验证",
    ],
    "End-to-End Encrypted": [
      "Ende-zu-Ende-verschlüsselt",
      "Chiffré de bout en bout",
      "エンドツーエンド暗号化済み",
      "Zaszyfrowane end-to-end",
      "端到端加密",
    ],
    "{label}. View safety numbers": [
      "{label}. Sicherheitsnummern anzeigen",
      "{label}. Voir les numéros de sécurité",
      "{label}。安全番号を表示",
      "{label}. Pokaż numery bezpieczeństwa",
      "{label}。查看安全码",
    ],
    "Turn on end-to-end encryption": [
      "Ende-zu-Ende-Verschlüsselung aktivieren",
      "Activer le chiffrement de bout en bout",
      "エンドツーエンド暗号化をオンにする",
      "Włącz szyfrowanie end-to-end",
      "开启端到端加密",
    ],
    "{name}'s safety number changed. Sending is paused until you review it.": [
      "Die Sicherheitsnummer von {name} hat sich geändert. Das Senden ist pausiert, bis du sie prüfst.",
      "Le numéro de sécurité de {name} a changé. L'envoi est suspendu jusqu'à ce que tu le vérifies.",
      "{name} の安全番号が変更されました。確認するまで送信は一時停止されます。",
      "Numer bezpieczeństwa użytkownika {name} się zmienił. Wysyłanie jest wstrzymane, dopóki go nie sprawdzisz.",
      "{name} 的安全码已更改。在你查看之前，发送已暂停。",
    ],
    "Unlock this browser to read and send encrypted messages here.": [
      "Entsperre diesen Browser, um hier verschlüsselte Nachrichten zu lesen und zu senden.",
      "Déverrouille ce navigateur pour lire et envoyer des messages chiffrés ici.",
      "ここで暗号化されたメッセージを読んだり送ったりするには、このブラウザのロックを解除してください。",
      "Odblokuj tę przeglądarkę, aby czytać i wysyłać tu zaszyfrowane wiadomości.",
      "解锁此浏览器以在这里读取和发送加密消息。",
    ],
    "Back up your encryption keys with your password so your other browsers can read your encrypted messages.":
      [
        "Sichere deine Schlüssel mit deinem Passwort, damit deine anderen Browser deine verschlüsselten Nachrichten lesen können.",
        "Sauvegarde tes clés de chiffrement avec ton mot de passe pour que tes autres navigateurs puissent lire tes messages chiffrés.",
        "パスワードで暗号鍵をバックアップすると、他のブラウザでも暗号化されたメッセージを読めるようになります。",
        "Utwórz kopię kluczy szyfrowania chronioną hasłem, aby inne przeglądarki mogły odczytać twoje zaszyfrowane wiadomości.",
        "用你的密码备份加密密钥，这样你的其他浏览器也能读取你的加密消息。",
      ],
    "End-to-end encryption is unavailable in this client build, so sending in encrypted conversations is turned off.":
      [
        "Die Ende-zu-Ende-Verschlüsselung ist in dieser Client-Version nicht verfügbar, daher ist das Senden in verschlüsselten Unterhaltungen deaktiviert.",
        "Le chiffrement de bout en bout n'est pas disponible dans cette version du client, l'envoi dans les conversations chiffrées est donc désactivé.",
        "このクライアントのビルドではエンドツーエンド暗号化を利用できないため、暗号化された会話での送信はオフになっています。",
        "Szyfrowanie end-to-end jest niedostępne w tej wersji klienta, więc wysyłanie w szyfrowanych rozmowach jest wyłączone.",
        "此客户端版本不支持端到端加密，因此已关闭在加密对话中发送消息。",
      ],
    "Encryption is paused because this account set up too many browsers recently. It will try again at {time}.":
      [
        "Die Verschlüsselung ist pausiert, weil dieses Konto zuletzt zu viele Browser eingerichtet hat. Um {time} wird es erneut versucht.",
        "Le chiffrement est en pause, car ce compte a configuré trop de navigateurs récemment. Nouvel essai à {time}.",
        "このアカウントで最近設定されたブラウザが多すぎるため、暗号化は一時停止しています。{time} に再試行します。",
        "Szyfrowanie jest wstrzymane, bo na tym koncie skonfigurowano ostatnio zbyt wiele przeglądarek. Kolejna próba o {time}.",
        "此账号最近设置的浏览器过多，加密已暂停。将在 {time} 重试。",
      ],
    "Encryption couldn't reach the server, so sending in encrypted conversations is paused. It will try again shortly.":
      [
        "Die Verschlüsselung konnte den Server nicht erreichen, daher ist das Senden in verschlüsselten Unterhaltungen pausiert. Es wird gleich erneut versucht.",
        "Le chiffrement n'a pas pu joindre le serveur, l'envoi dans les conversations chiffrées est donc en pause. Nouvel essai sous peu.",
        "暗号化でサーバーに接続できなかったため、暗号化された会話での送信は一時停止しています。まもなく再試行します。",
        "Szyfrowanie nie mogło połączyć się z serwerem, więc wysyłanie w szyfrowanych rozmowach jest wstrzymane. Za chwilę nastąpi kolejna próba.",
        "加密无法连接服务器，因此加密对话中的发送已暂停。稍后将重试。",
      ],
    "Encryption is unavailable in this client build": [
      "Verschlüsselung ist in dieser Client-Version nicht verfügbar",
      "Le chiffrement n'est pas disponible dans cette version du client",
      "このクライアントのビルドでは暗号化を利用できません",
      "Szyfrowanie jest niedostępne w tej wersji klienta",
      "此客户端版本不支持加密",
    ],
    "Polls can't be sent in encrypted conversations yet": [
      "In verschlüsselten Unterhaltungen können noch keine Umfragen gesendet werden",
      "Les sondages ne peuvent pas encore être envoyés dans les conversations chiffrées",
      "暗号化された会話ではまだ投票を送信できません",
      "W szyfrowanych rozmowach nie można jeszcze wysyłać ankiet",
      "加密对话中暂时无法发送投票",
    ],
    "This file couldn't be encrypted": [
      "Diese Datei konnte nicht verschlüsselt werden",
      "Ce fichier n'a pas pu être chiffré",
      "このファイルを暗号化できませんでした",
      "Nie udało się zaszyfrować tego pliku",
      "此文件无法加密",
    ],
    "A file wasn't encrypted before it was uploaded": [
      "Eine Datei wurde vor dem Hochladen nicht verschlüsselt",
      "Un fichier n'a pas été chiffré avant d'être envoyé",
      "アップロード前に暗号化されていないファイルがあります",
      "Plik nie został zaszyfrowany przed przesłaniem",
      "有文件在上传前没有加密",
    ],
    "This message isn't decrypted in this browser yet": [
      "Diese Nachricht ist in diesem Browser noch nicht entschlüsselt",
      "Ce message n'est pas encore déchiffré dans ce navigateur",
      "このメッセージはこのブラウザでまだ復号されていません",
      "Ta wiadomość nie jest jeszcze odszyfrowana w tej przeglądarce",
      "这条消息还没有在此浏览器中解密",
    ],
    "Your keys couldn't be backed up. Try again in a moment.": [
      "Deine Schlüssel konnten nicht gesichert werden. Versuche es gleich noch einmal.",
      "Tes clés n'ont pas pu être sauvegardées. Réessaie dans un instant.",
      "鍵をバックアップできませんでした。しばらくしてからもう一度お試しください。",
      "Nie udało się utworzyć kopii kluczy. Spróbuj ponownie za chwilę.",
      "无法备份你的密钥。请稍后再试。",
    ],
    "Your keys aren't backed up with your password yet.": [
      "Deine Schlüssel sind noch nicht mit deinem Passwort gesichert.",
      "Tes clés ne sont pas encore sauvegardées avec ton mot de passe.",
      "鍵はまだパスワードでバックアップされていません。",
      "Twoje klucze nie mają jeszcze kopii chronionej hasłem.",
      "你的密钥还没有用密码备份。",
    ],
    "There's no backup to unlock with that": [
      "Es gibt keine Sicherung, die sich damit entsperren lässt",
      "Aucune sauvegarde ne peut être déverrouillée avec cela",
      "これでロックを解除できるバックアップはありません",
      "Nie ma kopii, którą można tym odblokować",
      "没有可以用它解锁的备份",
    ],
    "That password didn't unlock your keys": [
      "Dieses Passwort hat deine Schlüssel nicht entsperrt",
      "Ce mot de passe n'a pas déverrouillé tes clés",
      "このパスワードでは鍵のロックを解除できませんでした",
      "To hasło nie odblokowało twoich kluczy",
      "此密码无法解锁你的密钥",
    ],
    "That recovery code didn't work": [
      "Dieser Wiederherstellungscode hat nicht funktioniert",
      "Ce code de récupération n'a pas fonctionné",
      "このリカバリーコードは使えませんでした",
      "Ten kod odzyskiwania nie zadziałał",
      "此恢复码无效",
    ],
    "That key didn't unlock this browser": [
      "Dieser Schlüssel hat diesen Browser nicht entsperrt",
      "Cette clé n'a pas déverrouillé ce navigateur",
      "この鍵ではこのブラウザのロックを解除できませんでした",
      "Ten klucz nie odblokował tej przeglądarki",
      "此密钥无法解锁此浏览器",
    ],
    "Unlock this browser first": [
      "Entsperre zuerst diesen Browser",
      "Déverrouille d'abord ce navigateur",
      "先にこのブラウザのロックを解除してください",
      "Najpierw odblokuj tę przeglądarkę",
      "请先解锁此浏览器",
    ],
    "There's no backup yet": [
      "Es gibt noch keine Sicherung",
      "Il n'y a pas encore de sauvegarde",
      "まだバックアップがありません",
      "Nie ma jeszcze kopii",
      "还没有备份",
    ],
    "Encryption is still starting up": [
      "Die Verschlüsselung wird noch gestartet",
      "Le chiffrement est en cours de démarrage",
      "暗号化はまだ起動中です",
      "Szyfrowanie wciąż się uruchamia",
      "加密仍在启动中",
    ],
    "This browser isn't unlocked for encrypted messages yet": [
      "Dieser Browser ist noch nicht für verschlüsselte Nachrichten entsperrt",
      "Ce navigateur n'est pas encore déverrouillé pour les messages chiffrés",
      "このブラウザはまだ暗号化されたメッセージ用にロック解除されていません",
      "Ta przeglądarka nie jest jeszcze odblokowana dla zaszyfrowanych wiadomości",
      "此浏览器还没有为加密消息解锁",
    ],
    "This browser isn't unlocked yet": [
      "Dieser Browser ist noch nicht entsperrt",
      "Ce navigateur n'est pas encore déverrouillé",
      "このブラウザはまだロック解除されていません",
      "Ta przeglądarka nie jest jeszcze odblokowana",
      "此浏览器还没有解锁",
    ],
    "Unknown sender device": [
      "Unbekanntes Absendergerät",
      "Appareil expéditeur inconnu",
      "送信元のデバイスが不明です",
      "Nieznane urządzenie nadawcy",
      "未知的发送设备",
    ],
    "Signature check failed": [
      "Signaturprüfung fehlgeschlagen",
      "Échec de la vérification de la signature",
      "署名の検証に失敗しました",
      "Weryfikacja podpisu nie powiodła się",
      "签名校验失败",
    ],
    "This browser can't approve logins": [
      "Dieser Browser kann keine Anmeldungen bestätigen",
      "Ce navigateur ne peut pas approuver de connexions",
      "このブラウザではログインを承認できません",
      "Ta przeglądarka nie może zatwierdzać logowań",
      "此浏览器无法批准登录",
    ],
    "This message couldn't be decrypted": [
      "Diese Nachricht konnte nicht entschlüsselt werden",
      "Ce message n'a pas pu être déchiffré",
      "このメッセージを復号できませんでした",
      "Nie udało się odszyfrować tej wiadomości",
      "无法解密此消息",
    ],
    "Sent before encryption was reset": [
      "Vor dem Zurücksetzen der Verschlüsselung gesendet",
      "Envoyé avant la réinitialisation du chiffrement",
      "暗号化をリセットする前に送信されました",
      "Wysłano przed zresetowaniem szyfrowania",
      "在重置加密之前发送",
    ],
    "The sender's device couldn't be verified": [
      "Das Gerät des Absenders konnte nicht überprüft werden",
      "L'appareil de l'expéditeur n'a pas pu être vérifié",
      "送信者のデバイスを確認できませんでした",
      "Nie udało się zweryfikować urządzenia nadawcy",
      "无法验证发送者的设备",
    ],
    "Sent from a device that was removed": [
      "Von einem entfernten Gerät gesendet",
      "Envoyé depuis un appareil qui a été retiré",
      "削除されたデバイスから送信されました",
      "Wysłano z urządzenia, które zostało usunięte",
      "从已移除的设备发送",
    ],
    "Your signed-in browsers are asking you to approve this one. Approve it on any of them after checking that it shows the code listed under its name.":
      [
        "Deine angemeldeten Browser fragen, ob du diesen bestätigen willst. Bestätige ihn auf einem davon, nachdem du geprüft hast, dass er den Code unter seinem Namen anzeigt.",
        "Tes navigateurs connectés te demandent d'approuver celui-ci. Approuve-le sur l'un d'eux après avoir vérifié qu'il affiche le code indiqué sous son nom.",
        "サインイン中のブラウザがこのブラウザの承認を求めています。名前の下に表示されているコードと同じものが表示されていることを確認してから、いずれかで承認してください。",
        "Twoje zalogowane przeglądarki proszą o zatwierdzenie tej. Zatwierdź ją w dowolnej z nich, gdy sprawdzisz, że wyświetla kod podany pod jej nazwą.",
        "你已登录的浏览器正在请求你批准此浏览器。请确认它显示的是其名称下列出的代码，然后在任意一个上批准。",
      ],
    "Your other browser": [
      "Dein anderer Browser",
      "Ton autre navigateur",
      "別のブラウザ",
      "Twoja inna przeglądarka",
      "你的另一个浏览器",
    ],
    "The approval didn't unlock this browser. {error}": [
      "Die Bestätigung hat diesen Browser nicht entsperrt. {error}",
      "L'approbation n'a pas déverrouillé ce navigateur. {error}",
      "承認してもこのブラウザのロックは解除されませんでした。{error}",
      "Zatwierdzenie nie odblokowało tej przeglądarki. {error}",
      "批准没有解锁此浏览器。{error}",
    ],
    "This browser is unlocked.": [
      "Dieser Browser ist entsperrt.",
      "Ce navigateur est déverrouillé.",
      "このブラウザのロックを解除しました。",
      "Ta przeglądarka jest odblokowana.",
      "此浏览器已解锁。",
    ],
    "Couldn't answer that login. {error}": [
      "Auf diese Anmeldung konnte nicht geantwortet werden. {error}",
      "Impossible de répondre à cette connexion. {error}",
      "このログインに応答できませんでした。{error}",
      "Nie udało się odpowiedzieć na to logowanie. {error}",
      "无法回应此登录。{error}",
    ],
    "Couldn't switch to the recovery code. {error}": [
      "Der Wechsel zum Wiederherstellungscode hat nicht geklappt. {error}",
      "Impossible de passer au code de récupération. {error}",
      "リカバリーコードに切り替えられませんでした。{error}",
      "Nie udało się przełączyć na kod odzyskiwania. {error}",
      "无法切换到恢复代码。{error}",
    ],
    "Couldn't remove it. {error}": [
      "Entfernen fehlgeschlagen. {error}",
      "Impossible de le retirer. {error}",
      "削除できませんでした。{error}",
      "Nie udało się usunąć. {error}",
      "无法移除。{error}",
    ],
    "If your password doesn't unlock your keys and no other browser can approve a new one, reset encryption to keep chatting. Messages sent before the reset can't be read anymore.":
      [
        "Wenn dein Passwort deine Schlüssel nicht entsperrt und kein anderer Browser einen neuen bestätigen kann, setze die Verschlüsselung zurück, um weiterzuchatten. Vor dem Zurücksetzen gesendete Nachrichten können dann nicht mehr gelesen werden.",
        "Si ton mot de passe ne déverrouille pas tes clés et qu'aucun autre navigateur ne peut en approuver un nouveau, réinitialise le chiffrement pour continuer à discuter. Les messages envoyés avant la réinitialisation ne pourront plus être lus.",
        "パスワードで鍵のロックを解除できず、ほかのブラウザで新しいブラウザを承認できない場合は、暗号化をリセットするとチャットを続けられます。リセット前に送信されたメッセージは読めなくなります。",
        "Jeśli hasło nie odblokowuje twoich kluczy i żadna inna przeglądarka nie może zatwierdzić nowej, zresetuj szyfrowanie, aby dalej rozmawiać. Wiadomości wysłanych przed resetem nie będzie już można przeczytać.",
        "如果你的密码无法解锁密钥，并且没有其他浏览器可以批准新的浏览器，请重置加密以继续聊天。重置之前发送的消息将无法再读取。",
      ],
    Asked: ["Angefragt", "Demandé", "依頼済み", "Wysłano prośbę", "已请求"],
    Approve: ["Bestätigen", "Approuver", "承認", "Zatwierdź", "批准"],
    "Couldn't ask that browser for approval. {error}": [
      "Dieser Browser konnte nicht um Bestätigung gebeten werden. {error}",
      "Impossible de demander l'approbation à ce navigateur. {error}",
      "そのブラウザに承認を依頼できませんでした。{error}",
      "Nie udało się poprosić tej przeglądarki o zatwierdzenie. {error}",
      "无法请求该浏览器批准。{error}",
    ],
    "That browser shows a code and asks you to approve it here once it's open.": [
      "Sobald dieser Browser geöffnet ist, zeigt er einen Code an und bittet dich, ihn hier zu bestätigen.",
      "Une fois ouvert, ce navigateur affiche un code et te demande de l'approuver ici.",
      "そのブラウザを開くとコードが表示され、ここで承認するよう求められます。",
      "Gdy ta przeglądarka zostanie otwarta, wyświetli kod i poprosi o zatwierdzenie jej tutaj.",
      "该浏览器打开后会显示一个代码，并请你在这里批准它。",
    ],
    "Sent before encryption was reset, so it can't be read anymore": [
      "Vor dem Zurücksetzen der Verschlüsselung gesendet und daher nicht mehr lesbar",
      "Envoyé avant la réinitialisation du chiffrement, il ne peut donc plus être lu",
      "暗号化をリセットする前に送信されたため、読めなくなりました",
      "Wysłano przed zresetowaniem szyfrowania, więc nie można jej już przeczytać",
      "在重置加密之前发送，因此已无法读取",
    ],
    "Couldn't decrypt this message. {reason}": [
      "Diese Nachricht konnte nicht entschlüsselt werden. {reason}",
      "Impossible de déchiffrer ce message. {reason}",
      "このメッセージを復号できませんでした。{reason}",
      "Nie udało się odszyfrować tej wiadomości. {reason}",
      "无法解密此消息。{reason}",
    ],
    "Couldn't decrypt this message.": [
      "Diese Nachricht konnte nicht entschlüsselt werden.",
      "Impossible de déchiffrer ce message.",
      "このメッセージを復号できませんでした。",
      "Nie udało się odszyfrować tej wiadomości.",
      "无法解密此消息。",
    ],
    "Compare these numbers with each person in a call or face to face. If they match, nobody is intercepting your messages. Mark them as verified so you're warned if they change.":
      [
        "Vergleiche diese Nummern mit jeder Person in einem Anruf oder persönlich. Wenn sie übereinstimmen, fängt niemand deine Nachrichten ab. Markiere sie als verifiziert, damit du gewarnt wirst, wenn sie sich ändern.",
        "Compare ces numéros avec chaque personne lors d'un appel ou en face à face. S'ils correspondent, personne n'intercepte tes messages. Marque-les comme vérifiés pour être averti s'ils changent.",
        "通話や対面で相手とこの番号を照合してください。一致していれば、メッセージは誰にも傍受されていません。認証済みにしておくと、番号が変わったときに警告されます。",
        "Porównaj te numery z każdą osobą podczas rozmowy lub osobiście. Jeśli się zgadzają, nikt nie przechwytuje twoich wiadomości. Oznacz je jako zweryfikowane, aby dostać ostrzeżenie, gdy się zmienią.",
        "请通过通话或当面与每个人核对这些数字。如果一致，就没有人在拦截你的消息。将其标记为已验证，之后如有变化你会收到提醒。",
      ],
    "This replaces your encryption keys. Only do this if you think someone else got hold of them.":
      [
        "Damit ersetzt du deine Schlüssel. Tu das nur, wenn du glaubst, dass jemand anderes an sie gekommen ist.",
        "Cela remplace tes clés de chiffrement. Ne fais cela que si tu penses que quelqu'un d'autre les a obtenues.",
        "暗号鍵を置き換えます。他の誰かに鍵を知られたと思う場合にのみ実行してください。",
        "To zastępuje twoje klucze szyfrowania. Zrób to tylko wtedy, gdy podejrzewasz, że ktoś inny je zdobył.",
        "这会替换你的加密密钥。只有在你认为其他人拿到了它们时才这样做。",
      ],
    "Only do this if you lost your recovery code and no other signed-in browser can approve this one.":
      [
        "Tu das nur, wenn du deinen Wiederherstellungscode verloren hast und kein anderer angemeldeter Browser diesen bestätigen kann.",
        "Ne fais cela que si tu as perdu ton code de récupération et qu'aucun autre navigateur connecté ne peut approuver celui-ci.",
        "リカバリーコードをなくし、ログイン中の他のブラウザでこのブラウザを承認できない場合にのみ実行してください。",
        "Zrób to tylko wtedy, gdy zgubiłeś kod odzyskiwania i żadna inna zalogowana przeglądarka nie może zatwierdzić tej.",
        "只有在你丢失了恢复码，并且没有其他已登录的浏览器可以批准此浏览器时才这样做。",
      ],
    "Only do this if your password doesn't unlock your keys and no other signed-in browser can approve this one.":
      [
        "Tu das nur, wenn dein Passwort deine Schlüssel nicht entsperrt und kein anderer angemeldeter Browser diesen bestätigen kann.",
        "Ne fais ça que si ton mot de passe ne déverrouille pas tes clés et qu'aucun autre navigateur connecté ne peut approuver celui-ci.",
        "パスワードで鍵のロックを解除できず、ほかにサインイン中のブラウザでこのブラウザを承認できない場合にだけ実行してください。",
        "Zrób to tylko wtedy, gdy hasło nie odblokowuje twoich kluczy i żadna inna zalogowana przeglądarka nie może zatwierdzić tej.",
        "只有在你的密码无法解锁密钥，并且没有其他已登录的浏览器可以批准此浏览器时才这样做。",
      ],
    "You get new keys and can keep chatting, but none of your browsers can read the messages sent before the reset anymore. The people you talk to keep what they received.":
      [
        "Du bekommst neue Schlüssel und kannst weiterchatten, aber keiner deiner Browser kann die vor dem Zurücksetzen gesendeten Nachrichten noch lesen. Die Personen, mit denen du schreibst, behalten, was sie erhalten haben.",
        "Tu obtiens de nouvelles clés et peux continuer à discuter, mais aucun de tes navigateurs ne pourra plus lire les messages envoyés avant la réinitialisation. Les personnes avec qui tu discutes gardent ce qu'elles ont reçu.",
        "新しい鍵が作成されて会話を続けられますが、リセット前に送信されたメッセージはあなたのどのブラウザでも読めなくなります。相手が受け取ったメッセージは相手の側に残ります。",
        "Dostaniesz nowe klucze i możesz dalej rozmawiać, ale żadna z twoich przeglądarek nie odczyta już wiadomości wysłanych przed resetem. Osoby, z którymi rozmawiasz, zachowują to, co otrzymały.",
        "你会获得新的密钥并可以继续聊天，但你的任何浏览器都将无法再读取重置前发送的消息。与你聊天的人仍会保留他们收到的内容。",
      ],
    "Approve it only if you just signed in there yourself, because it gets access to your encrypted messages. Deny signs it out. The other browser should show this code:":
      [
        "Bestätige sie nur, wenn du dich gerade selbst dort angemeldet hast, denn sie erhält Zugriff auf deine verschlüsselten Nachrichten. Ablehnen meldet sie ab. Der andere Browser sollte diesen Code anzeigen:",
        "N'approuve que si tu viens de t'y connecter toi-même, car elle aura accès à tes messages chiffrés. Refuser la déconnecte. L'autre navigateur doit afficher ce code :",
        "暗号化されたメッセージにアクセスできるようになるため、自分でログインした場合にのみ承認してください。拒否するとそのブラウザはログアウトされます。相手のブラウザには次のコードが表示されているはずです：",
        "Zatwierdź tylko wtedy, gdy przed chwilą sam się tam zalogowałeś, bo uzyska dostęp do twoich zaszyfrowanych wiadomości. Odrzucenie ją wyloguje. Druga przeglądarka powinna pokazywać ten kod:",
        "只有在你刚刚亲自在那里登录时才批准，因为它将能访问你的加密消息。拒绝会让它退出登录。另一个浏览器应显示此代码：",
      ],
    "Signed in {date}": [
      "Angemeldet am {date}",
      "Connecté le {date}",
      "{date} にログイン",
      "Zalogowano {date}",
      "登录于 {date}",
    ],
    "Unlocked browsers can read your encrypted messages, and browsers waiting for approval can once you approve them. Remove the ones you don't recognize or don't use anymore.":
      [
        "Entsperrte Browser können deine verschlüsselten Nachrichten lesen, Browser, die auf Bestätigung warten, sobald du sie bestätigst. Entferne die, die du nicht erkennst oder nicht mehr benutzt.",
        "Les navigateurs déverrouillés peuvent lire tes messages chiffrés, et ceux en attente d'approbation le pourront une fois approuvés. Retire ceux que tu ne reconnais pas ou que tu n'utilises plus.",
        "ロック解除済みのブラウザは暗号化されたメッセージを読めます。承認待ちのブラウザは、承認すると読めるようになります。心当たりのないものや使わなくなったものは削除してください。",
        "Odblokowane przeglądarki mogą odczytać twoje zaszyfrowane wiadomości, a te czekające na zatwierdzenie będą mogły po zatwierdzeniu. Usuń te, których nie rozpoznajesz lub już nie używasz.",
        "已解锁的浏览器可以读取你的加密消息，等待批准的浏览器在你批准后也可以。请移除你不认识或不再使用的浏览器。",
      ],
    "This login was denied on your other browser, so this browser was signed out.": [
      "Diese Anmeldung wurde auf deinem anderen Browser abgelehnt, daher wurde dieser Browser abgemeldet.",
      "Cette connexion a été refusée sur ton autre navigateur, ce navigateur a donc été déconnecté.",
      "このログインは別のブラウザで拒否されたため、このブラウザはログアウトされました。",
      "To logowanie zostało odrzucone w twojej innej przeglądarce, więc ta przeglądarka została wylogowana.",
      "此登录已在你的另一个浏览器上被拒绝，因此此浏览器已退出登录。",
    ],
    "{names} haven't set up encryption yet, so this conversation can't be encrypted. Ask them to open the app once, then try again.":
      [
        "{names} haben die Verschlüsselung noch nicht eingerichtet, daher kann diese Unterhaltung nicht verschlüsselt werden. Bitte sie, die App einmal zu öffnen, und versuche es dann erneut.",
        "{names} n'ont pas encore configuré le chiffrement, cette conversation ne peut donc pas être chiffrée. Demande-leur d'ouvrir l'appli une fois, puis réessaie.",
        "{names} はまだ暗号化を設定していないため、この会話は暗号化できません。一度アプリを開いてもらってから、もう一度お試しください。",
        "{names} nie skonfigurowali jeszcze szyfrowania, więc tej rozmowy nie można zaszyfrować. Poproś ich, żeby raz otworzyli aplikację, i spróbuj ponownie.",
        "{names} 还没有设置加密，因此无法加密此对话。请让他们打开一次应用，然后再试一次。",
      ],
    "{name} hasn't set up encryption yet, so this conversation can't be encrypted. Ask them to open the app once, then try again.":
      [
        "{name} hat die Verschlüsselung noch nicht eingerichtet, daher kann diese Unterhaltung nicht verschlüsselt werden. Bitte die Person, die App einmal zu öffnen, und versuche es dann erneut.",
        "{name} n'a pas encore configuré le chiffrement, cette conversation ne peut donc pas être chiffrée. Demande-lui d'ouvrir l'appli une fois, puis réessaie.",
        "{name} はまだ暗号化を設定していないため、この会話は暗号化できません。一度アプリを開いてもらってから、もう一度お試しください。",
        "{name} nie skonfigurował(a) jeszcze szyfrowania, więc tej rozmowy nie można zaszyfrować. Poproś tę osobę, żeby raz otworzyła aplikację, i spróbuj ponownie.",
        "{name} 还没有设置加密，因此无法加密此对话。请让对方打开一次应用，然后再试一次。",
      ],
    "Couldn't turn on encryption. {error}": [
      "Die Verschlüsselung konnte nicht eingeschaltet werden. {error}",
      "Impossible d'activer le chiffrement. {error}",
      "暗号化をオンにできませんでした。{error}",
      "Nie udało się włączyć szyfrowania. {error}",
      "无法开启加密。{error}",
    ],
  };
  var locale = () => document.documentElement.lang || navigator.language || "en-US";
  var t = (text, vars = {}) => {
    const lang = locale();
    const index = LOCALES.findIndex((x) => x === lang || x === lang.split("-")[0]);
    const translated = (index === -1 ? undefined : STRINGS[text]?.[index]) ?? text;
    return translated.replace(/\{(\w+)\}/g, (match, key) =>
      key in vars ? String(vars[key]) : match,
    );
  };
  var conjunction = (items) => new Intl.ListFormat(locale(), { type: "conjunction" }).format(items);

  // client/e2ee/src/engine.ts
  var FALLBACK_CONTENT = "\uD83D\uDD12 Encrypted message";
  var WRAP_INFO = "fosscord-e2ee/v1/wrap";
  var BACKUP_INFO = "fosscord-e2ee/v1/backup-wrap";
  var PREKEY_ROTATE_MS = 7 * 24 * 3600 * 1000;
  var PREKEY_KEEP_MS = 30 * 24 * 3600 * 1000;
  var DIRECTORY_TTL_MS = 5 * 60 * 1000;
  var PASSWORD_TTL_MS = 10 * 60 * 1000;

  class E2eeError extends Error {
    code;
    userId;
    constructor(code, message, userId) {
      super(message);
      this.code = code;
      this.userId = userId;
    }
  }
  var errorText = (error) => {
    if (error instanceof Error) return error.message;
    const failure = error;
    if (failure && typeof failure === "object") {
      if (failure.status === 429) {
        const minutes = Math.max(1, Math.ceil(Number(failure.body?.retry_after ?? 60) / 60));
        return `Too many attempts. Try again in ${minutes === 1 ? "a minute" : `${minutes} minutes`}.`;
      }
      if (typeof failure.body?.message === "string") return failure.body.message;
      if (failure.status) return `The server answered with an error (${failure.status}).`;
    }
    return String(error);
  };
  var snowflakeTime = (id) => {
    try {
      return Number((BigInt(id) >> 22n) + 1420070400000n);
    } catch {
      return 0;
    }
  };
  var binding = (mid, nonce) => (mid ? `m:${mid}` : `n:${nonce ?? ""}`);
  var messageAad = (channelId, senderId, senderDevice, bind) => `fosscord-e2ee/v1/msg
${channelId}
${senderId}
${senderDevice}
${bind}`;
  var storedKeyAad = (userId, messageId, sig) => `fosscord-e2ee/v1/backup-key
${userId}
${messageId}
${sig}`;
  var sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
  var sleep = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  var signedPayload = (channelId, senderId, bind, env) => {
    const base = [
      "fosscord-e2ee/v1/sig",
      channelId,
      senderId,
      bind,
      env.v,
      env.alg,
      env.sender_device,
      env.mid ?? null,
      env.iv,
      env.ct,
      [...env.keys]
        .sort((a, b) => (a.device_id < b.device_id ? -1 : 1))
        .map((k) => [k.user_id, k.device_id, k.prekey_id, k.enc, k.wrapped]),
    ];
    if (env.backup)
      base.push(
        [...env.backup]
          .sort((a, b) => (a.user_id < b.user_id ? -1 : 1))
          .map((b) => [b.user_id, b.enc, b.wrapped]),
      );
    return JSON.stringify(base);
  };
  var deviceName = () => {
    const ua = navigator.userAgent;
    const brave = !!navigator.brave;
    const browser = brave
      ? "Brave"
      : /Edg\//.test(ua)
        ? "Edge"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Vivaldi\//.test(ua)
            ? "Vivaldi"
            : /Firefox\//.test(ua)
              ? "Firefox"
              : /Chrome\//.test(ua)
                ? "Chrome"
                : /Safari\//.test(ua)
                  ? "Safari"
                  : "a browser";
    const os = /Windows/.test(ua)
      ? "Windows"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
    return os ? `${browser} on ${os}` : browser;
  };
  var addedAt = (iso, seconds) =>
    new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(seconds && { second: "2-digit" }),
    });
  var deviceTitle = (device) => {
    const os = device.session?.os;
    const browser = device.session?.browser;
    if (os) return browser ? `${os} • ${browser}` : os;
    return device.name;
  };
  var deviceAdded = (devices, device) => {
    if (!device.created_at) return null;
    const minutes = devices
      .filter((d) => d.status !== "revoked" && d.created_at)
      .map((d) => addedAt(d.created_at, false));
    return addedAt(device.created_at, new Set(minutes).size < minutes.length);
  };
  var deviceTwins = (devices, device) =>
    devices.filter((d) => d.status !== "revoked" && deviceTitle(d) === deviceTitle(device));
  var deviceLabel = (devices, deviceId, fallback) => {
    const device = devices.find((d) => d.device_id === deviceId);
    const title = device && deviceTitle(device);
    if (!device || !title) return fallback;
    const twins = deviceTwins(devices, device);
    const added = twins.length > 1 ? deviceAdded(twins, device) : null;
    return added ? `${title}, added ${added}` : title;
  };

  class Engine {
    api;
    classifyChannel;
    trustDirectory;
    userId = "";
    linked = false;
    deviceStatus = "unregistered";
    identity = null;
    trustedKey = null;
    serverKey = null;
    identityCreatedAt = null;
    previousIdentities = [];
    device = null;
    devices = [];
    prekeys = [];
    contacts = {};
    encryptedChannels = new Set();
    backup = null;
    backupKeyPair = null;
    secret = null;
    password = null;
    store = null;
    queue = Promise.resolve();
    directory = new Map();
    members = new Map();
    profiles = new Map();
    plaintext = new Map();
    listeners = new Set();
    unlockListeners = new Set();
    wipeListeners = new Set();
    uploads = new Map();
    uploadTimer = null;
    lookups = new Map();
    lookupTimer = null;
    storedKeys = new Map();
    backfilling = false;
    wiped = false;
    freshIdentity = null;
    trustVersion = -1;
    privateByDefault = true;
    recoveryPublished = "";
    recoveryPublishing = new Map();
    constructor(api, classifyChannel = () => false, trustDirectory = () => false) {
      this.api = api;
      this.classifyChannel = classifyChannel;
      this.trustDirectory = trustDirectory;
    }
    get trustsServer() {
      return this.trustDirectory();
    }
    get serverRecoveryReady() {
      return (
        !!this.backup &&
        !!this.device &&
        this.recoveryPublished ===
          `${this.backup.identity_key}:${this.backup.backup_public_key}:${this.backup.version}:${this.device.deviceId}`
      );
    }
    onChange(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    onUnlock(listener) {
      this.unlockListeners.add(listener);
      return () => this.unlockListeners.delete(listener);
    }
    onWipe(listener) {
      this.wipeListeners.add(listener);
      return () => this.wipeListeners.delete(listener);
    }
    holdPassword(value, persist = false) {
      this.password = { value, at: Date.now() };
      if (persist)
        holdPendingPassword(this.userId, value).catch((error) =>
          console.error("[e2ee] couldn't keep the password for a reload", error),
        );
    }
    dropPassword() {
      this.password = null;
      dropPendingPassword();
    }
    emit() {
      this.listeners.forEach((listener) => listener());
    }
    get hasSecret() {
      return !!this.secret;
    }
    get locked() {
      return !!this.userId && !this.linked;
    }
    get backupNeedsPassword() {
      if (!this.linked || !this.identity || this.identity.publicKey !== this.serverKey)
        return false;
      const backup = this.backup?.identity_key === this.serverKey ? this.backup : null;
      if (!backup) return true;
      return backup.mode === "password" && !backup.wrapped_secret && !!this.secret;
    }
    async backUpWithPassword(password) {
      this.holdPassword(password);
      await this.refresh();
      if (this.backupNeedsPassword)
        throw new E2eeError(
          "BAD_SECRET",
          t("Your keys couldn't be backed up. Try again in a moment."),
        );
    }
    rememberPassword(value, userId) {
      this.password = { value, at: Date.now() };
      holdPendingPassword(userId ?? this.userId, value).catch((error) =>
        console.error("[e2ee] couldn't keep the password for a reload", error),
      );
      if (this.userId)
        this.refresh().catch((error) => console.error("[e2ee] password refresh failed", error));
    }
    async passwordChanged(previous, next, api = this.api) {
      if (!this.userId) return this.rememberPassword(next);
      await this.serialized(async () => {
        const backup = (this.backup = await this.fetchBackup(api));
        if (!backup || backup.mode !== "password") return;
        let secret = this.secret;
        if (!secret && previous && backup.wrapped_secret)
          secret = await unwrapSecret(this.userId, backup, previous).catch(() => null);
        if (!secret) {
          this.holdPassword(next, true);
          return;
        }
        this.backup = await api.request("patch", "/users/@me/e2ee/backup", {
          version: backup.version,
          ...(await wrapSecret(this.userId, "password", next, secret)),
        });
        this.dropPassword();
      });
      this.emit();
    }
    async init(userId) {
      this.userId = userId;
      this.store = scoped(userId);
      this.contacts = (await this.store.get("contacts")) ?? {};
      this.previousIdentities = (await this.store.get("previous-identities")) ?? [];
      const pending = await takePendingPassword(userId, PASSWORD_TTL_MS);
      if (pending && !this.password) this.password = pending;
      await this.refresh();
    }
    serialized(task) {
      const run = this.queue.then(task);
      this.queue = run.then(
        () => {},
        () => {},
      );
      return run;
    }
    exclusive(task) {
      return navigator.locks
        ? navigator.locks.request(`fosscord-e2ee-keys:${this.userId}`, task)
        : task();
    }
    async refresh() {
      const wasLinked = this.linked;
      const hadBackupKey = !!this.backupKeyPair;
      await this.serialized(() => this.exclusive(() => this.ensureKeys()));
      if (this.wiped) {
        this.wiped = false;
        this.wipeListeners.forEach((listener) => listener());
      }
      this.emit();
      if ((!wasLinked && this.linked) || (!hadBackupKey && this.backupKeyPair))
        this.unlockListeners.forEach((listener) => listener());
      if (this.linked && this.backupKeyPair)
        this.backfill().catch((error) => console.error("[e2ee] backfill failed", error));
    }
    async saveContacts() {
      await this.store.set("contacts", this.contacts);
    }
    async newPrekey(id) {
      const keyPair = await generateAgreementKey();
      const publicKey = await exportPublic(keyPair.publicKey);
      const signature = await sign(
        this.device.privateKey,
        prekeyMessage(this.device.deviceId, id, publicKey),
      );
      return {
        id,
        publicKey,
        signature,
        keyPair,
        createdAt: Date.now(),
        retiredAt: null,
      };
    }
    currentPrekey() {
      return this.prekeys.reduce((a, b) => (b.id > a.id ? b : a));
    }
    async fetchBackup(api = this.api) {
      try {
        return await api.request("get", "/users/@me/e2ee/backup");
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
    }
    async adoptIdentity(jwk) {
      const identity = { publicKey: jwk.x, privateKey: await importSigningJwk(jwk) };
      await this.store.set("identity", identity);
      await this.trust(jwk.x);
      this.identity = identity;
      return identity;
    }
    async rememberIdentity(key) {
      if (!key || this.previousIdentities.includes(key)) return;
      this.previousIdentities = [...this.previousIdentities, key].slice(-16);
      await this.store.set("previous-identities", this.previousIdentities);
    }
    async trust(key) {
      if (this.trustedKey === key) return;
      await this.rememberIdentity(this.trustedKey);
      this.trustedKey = key;
      await this.store.set("trusted-identity", key);
    }
    async restoreFromSecret(secret, backup) {
      if (secret.byteLength !== 32) throw new Error("invalid backup secret");
      const identityJwk = await openJwk(secret, "identity", this.userId, backup.wrapped_identity);
      const backupJwk = await openJwk(secret, "backup-key", this.userId, backup.wrapped_backup_key);
      const valid = (jwk, curve, publicKey) =>
        jwk.kty === "OKP" &&
        jwk.crv === curve &&
        jwk.x === publicKey &&
        typeof jwk.d === "string" &&
        fromB64u(jwk.d).byteLength === 32 &&
        fromB64u(jwk.x).byteLength === 32;
      if (
        !valid(identityJwk, "Ed25519", backup.identity_key) ||
        !valid(backupJwk, "X25519", backup.backup_public_key)
      )
        throw new Error("backup keys don't match");
      if (
        !(await verify(
          backup.identity_key,
          backupKeyMessage(this.userId, backup.backup_public_key),
          backup.backup_key_signature,
        ))
      )
        throw new Error("invalid backup key signature");
      const identityPrivate = await importSigningJwk(identityJwk);
      const challenge = toB64u(randomBytes(32));
      if (!(await verify(backup.identity_key, challenge, await sign(identityPrivate, challenge))))
        throw new Error("backup identity private key doesn't match");
      const pair = await importAgreementJwk(backupJwk);
      const probe = await generateAgreementKey();
      if (
        !sameBytes(
          await x25519(pair.privateKey, await exportPublic(probe.publicKey)),
          await x25519(probe.privateKey, backup.backup_public_key),
        )
      )
        throw new Error("backup private key doesn't match");
      await this.adoptIdentity(identityJwk);
      this.backupKeyPair = { publicKey: backupJwk.x, keyPair: pair };
      this.secret = secret;
      await this.store.set("backup-secret", secret);
      return identityJwk;
    }
    async serverSecret(password) {
      if (!this.trustsServer) return null;
      const response = await this.api.request("post", "/users/@me/e2ee/backup/escrow/recover", {
        password,
      });
      const secret = fromB64u(response.backup_secret);
      if (secret.byteLength !== 32 || toB64u(secret) !== response.backup_secret)
        throw new Error("invalid server recovery secret");
      return secret;
    }
    async recoverWithPassword(password) {
      const secret = await this.serverSecret(password);
      if (!secret) return false;
      await this.unlockWithSecret(secret);
      return this.linked;
    }
    async publishServerRecovery(api = this.api) {
      const backup = this.backup;
      const identity = this.identity;
      const device = this.device;
      if (
        !this.trustsServer ||
        !this.linked ||
        !this.secret ||
        !identity ||
        !device ||
        !backup ||
        backup.identity_key !== identity.publicKey
      )
        return;
      const key = `${backup.identity_key}:${backup.backup_public_key}:${backup.version}:${device.deviceId}`;
      if (this.recoveryPublished === key) return;
      const pending = this.recoveryPublishing.get(key);
      if (pending) return pending;
      const originalSecret = this.secret;
      const secret = originalSecret.slice();
      const userId = this.userId;
      const current = () =>
        this.trustsServer &&
        this.linked &&
        this.userId === userId &&
        this.identity === identity &&
        this.device === device &&
        this.backup === backup &&
        this.secret === originalSecret &&
        `${backup.identity_key}:${backup.backup_public_key}:${backup.version}:${device.deviceId}` ===
          key;
      const publish = async () => {
        try {
          const status = await api.request("get", "/users/@me/e2ee/backup/escrow");
          if (!current()) return;
          if (
            !status.ready ||
            status.identity_key !== backup.identity_key ||
            status.backup_public_key !== backup.backup_public_key ||
            status.backup_version !== backup.version
          ) {
            const digest = toB64u(await sha256(secret));
            if (!current()) return;
            const message = `fosscord-e2ee/v1/server-recovery
${userId}
${backup.identity_key}
${backup.version}
${device.deviceId}
${digest}`;
            const signature = await sign(identity.privateKey, message);
            if (!current()) return;
            await api.request("put", "/users/@me/e2ee/backup/escrow", {
              identity_key: backup.identity_key,
              backup_version: backup.version,
              device_id: device.deviceId,
              backup_secret: toB64u(secret),
              signature,
            });
          }
          if (current()) this.recoveryPublished = key;
        } finally {
          secret.fill(0);
          this.recoveryPublishing.delete(key);
        }
      };
      const promise = Promise.resolve().then(publish);
      this.recoveryPublishing.set(key, promise);
      return promise;
    }
    passwordValue() {
      if (this.password && Date.now() - this.password.at > PASSWORD_TTL_MS) this.password = null;
      return this.password?.value ?? null;
    }
    async createBackup(state, identityJwk) {
      if (!this.passwordValue()) return;
      const userId = this.userId;
      let identity = this.identity;
      if (!identityJwk) {
        identityJwk = await generateExportable("Ed25519");
        const next = { publicKey: identityJwk.x, privateKey: await importSigningJwk(identityJwk) };
        const devices = [];
        for (const d of state.devices) {
          if (d.status === "revoked" || !d.identity_signature) continue;
          if (
            !(await verify(
              identity.publicKey,
              deviceMessage(userId, d.device_id, d.signing_key),
              d.identity_signature,
            ))
          )
            continue;
          devices.push({
            device_id: d.device_id,
            identity_signature: await sign(
              next.privateKey,
              deviceMessage(userId, d.device_id, d.signing_key),
            ),
          });
        }
        const previous_signature = await sign(
          identity.privateKey,
          rotationMessage(userId, identity.publicKey, next.publicKey),
        );
        Object.assign(
          state,
          await this.api.request("put", "/users/@me/e2ee/identity", {
            public_key: next.publicKey,
            previous_signature,
            devices,
          }),
        );
        identity = await this.adoptIdentity(identityJwk);
        this.directory.delete(userId);
      }
      const password = this.passwordValue();
      if (!password) return;
      const secret = randomBytes(32);
      const backupJwk = await generateExportable("X25519");
      const secretFields = await wrapSecret(userId, "password", password, secret);
      this.backup = await this.api.request("put", "/users/@me/e2ee/backup", {
        version: this.backup?.version ?? 0,
        ...secretFields,
        identity_key: identity.publicKey,
        wrapped_identity: await sealJwk(secret, "identity", userId, identityJwk),
        backup_public_key: backupJwk.x,
        backup_key_signature: await sign(
          identity.privateKey,
          backupKeyMessage(userId, backupJwk.x),
        ),
        wrapped_backup_key: await sealJwk(secret, "backup-key", userId, backupJwk),
      });
      this.dropPassword();
      this.secret = secret;
      await this.store.set("backup-secret", secret);
      this.backupKeyPair = { publicKey: backupJwk.x, keyPair: await importAgreementJwk(backupJwk) };
    }
    async syncPassword() {
      const password = this.passwordValue();
      const backup = this.backup;
      if (!password || !this.secret || !backup) return;
      if (backup.mode !== "password") {
        this.dropPassword();
        return;
      }
      const current = backup.wrapped_secret
        ? await unwrapSecret(this.userId, backup, password).catch(() => null)
        : null;
      if (!current || !sameBytes(current, this.secret))
        this.backup = await this.api.request("patch", "/users/@me/e2ee/backup", {
          version: backup.version,
          ...(await wrapSecret(this.userId, "password", password, this.secret)),
        });
      this.dropPassword();
    }
    async wipeLocal(keepTrust) {
      const store = this.store;
      if (!keepTrust) await this.rememberIdentity(this.trustedKey);
      for (const name of [
        "identity",
        "device",
        "prekeys",
        "backup-secret",
        ...(keepTrust ? [] : ["trusted-identity"]),
      ])
        await store.del(name);
      this.identity = null;
      this.device = null;
      this.prekeys = [];
      this.secret = null;
      this.backupKeyPair = null;
      this.linked = false;
      this.deviceStatus = "unregistered";
      if (!keepTrust) this.trustedKey = null;
      this.wiped = true;
    }
    async forget() {
      this.dropPassword();
      if (!this.store) return;
      await this.serialized(() => this.wipeLocal(true));
      this.wiped = false;
      this.userId = "";
      this.backup = null;
      this.devices = [];
      this.plaintext.clear();
      this.directory.clear();
      this.members.clear();
      this.emit();
    }
    async ensureKeys() {
      const store = this.store;
      const userId = this.userId;
      this.device = (await store.get("device")) ?? null;
      let state = await this.api.request(
        "get",
        `/users/@me/e2ee${this.device ? `?device_id=${encodeURIComponent(this.device.deviceId)}` : ""}`,
      );
      const revoked =
        this.device &&
        state.devices.find((d) => d.device_id === this.device.deviceId)?.status === "revoked"
          ? this.device.deviceId
          : null;
      if (revoked && (await store.get("device"))?.deviceId === revoked) await this.wipeLocal(true);
      this.encryptedChannels = new Set(state.channels);
      this.privateByDefault = state.private_by_default ?? this.privateByDefault;
      this.identity = (await store.get("identity")) ?? null;
      this.trustedKey = (await store.get("trusted-identity")) ?? null;
      this.prekeys = (await store.get("prekeys")) ?? [];
      this.secret = (await store.get("backup-secret")) ?? null;
      if (!this.secret) this.backupKeyPair = null;
      this.backup = await this.fetchBackup();
      let identityJwk = this.freshIdentity;
      this.freshIdentity = null;
      if (!state.identity_key) {
        identityJwk = await generateExportable("Ed25519");
        await this.adoptIdentity(identityJwk);
        state = await this.api.request("put", "/users/@me/e2ee/identity", {
          public_key: identityJwk.x,
        });
        this.secret = null;
        this.backupKeyPair = null;
      } else if (
        !this.backup &&
        !state.channels.length &&
        this.identity?.publicKey !== state.identity_key &&
        this.passwordValue()
      ) {
        const password = this.passwordValue();
        identityJwk = await generateExportable("Ed25519");
        state = await this.api.request("post", "/users/@me/e2ee/reset", {
          password,
          public_key: identityJwk.x,
        });
        await this.wipeLocal(false);
        await this.adoptIdentity(identityJwk);
        this.directory.clear();
      }
      const serverKey = state.identity_key;
      this.serverKey = serverKey;
      this.identityCreatedAt = state.identity_created_at
        ? Date.parse(state.identity_created_at)
        : null;
      if (this.identity && this.identity.publicKey !== serverKey) {
        const previous = state.previous_identity;
        const rotated =
          previous?.public_key === this.identity.publicKey &&
          (await verify(
            previous.public_key,
            rotationMessage(userId, previous.public_key, serverKey),
            previous.signature,
          ));
        this.identity = null;
        await store.del("identity");
        if (rotated) await this.trust(serverKey);
      }
      if (this.identity) await this.trust(this.identity.publicKey);
      const backup = this.backup?.identity_key === serverKey ? this.backup : null;
      if (
        backup &&
        this.secret &&
        (!this.identity ||
          !this.backupKeyPair ||
          this.backupKeyPair.publicKey !== backup.backup_public_key)
      ) {
        try {
          identityJwk = await this.restoreFromSecret(this.secret, backup);
        } catch (error) {
          console.error("[e2ee] stored backup secret doesn't open the backup", error);
          this.secret = null;
          this.backupKeyPair = null;
          await store.del("backup-secret");
        }
      }
      const password = this.passwordValue();
      if (
        backup &&
        !this.secret &&
        password &&
        backup.mode === "password" &&
        backup.wrapped_secret
      ) {
        const secret = await unwrapSecret(userId, backup, password).catch(() => null);
        if (secret) identityJwk = await this.restoreFromSecret(secret, backup);
      }
      if (backup && !this.secret && password && this.trustsServer) {
        const secret = await this.serverSecret(password).catch(() => null);
        if (secret) identityJwk = await this.restoreFromSecret(secret, backup);
      }
      if (this.identity && !backup) {
        try {
          await this.createBackup(state, identityJwk);
        } catch (error) {
          console.error("[e2ee] couldn't create the key backup", error);
        }
      }
      await this.syncPassword().catch((error) =>
        console.error("[e2ee] couldn't update the backup password", error),
      );
      const trusted = this.trustedKey === state.identity_key ? this.trustedKey : null;
      let serverDevice = this.device
        ? state.devices.find((d) => d.device_id === this.device.deviceId)
        : undefined;
      if (!this.device || serverDevice?.status === "revoked") {
        const pair = await generateSigningKey();
        const signingKey = await exportPublic(pair.publicKey);
        this.device = {
          deviceId: await deviceIdFor(signingKey),
          signingKey,
          privateKey: pair.privateKey,
        };
        this.prekeys = [];
        serverDevice = undefined;
        await store.set("device", this.device);
      }
      if (!this.prekeys.length) {
        this.prekeys = [await this.newPrekey(1)];
        await store.set("prekeys", this.prekeys);
      }
      let current = this.currentPrekey();
      if (serverDevice && Date.now() - current.createdAt > PREKEY_ROTATE_MS) {
        const next = await this.newPrekey(current.id + 1);
        current.retiredAt = Date.now();
        this.prekeys = [
          ...this.prekeys.filter((p) => !p.retiredAt || Date.now() - p.retiredAt < PREKEY_KEEP_MS),
          next,
        ];
        await store.set("prekeys", this.prekeys);
        await this.api.request("put", `/users/@me/e2ee/devices/${this.device.deviceId}/prekey`, {
          id: next.id,
          public_key: next.publicKey,
          signature: next.signature,
        });
        serverDevice.prekey = {
          id: next.id,
          public_key: next.publicKey,
          signature: next.signature,
        };
        current = next;
      }
      const message = deviceMessage(userId, this.device.deviceId, this.device.signingKey);
      const signedBy = async (device) =>
        !!trusted &&
        device?.status === "active" &&
        !!device.identity_signature &&
        (await verify(trusted, message, device.identity_signature));
      const canSign = !!this.identity && this.identity.publicKey === trusted;
      if (
        !serverDevice ||
        serverDevice.prekey.id !== current.id ||
        (canSign && !(await signedBy(serverDevice)))
      ) {
        serverDevice = await this.api.request("post", "/users/@me/e2ee/devices", {
          device_id: this.device.deviceId,
          signing_key: this.device.signingKey,
          identity_signature: canSign ? await sign(this.identity.privateKey, message) : undefined,
          name: deviceName(),
          prekey: { id: current.id, public_key: current.publicKey, signature: current.signature },
        });
        state.devices = [
          ...state.devices.filter((d) => d.device_id !== serverDevice.device_id),
          serverDevice,
        ];
      }
      this.devices = state.devices;
      this.deviceStatus = serverDevice.status;
      this.linked = await signedBy(serverDevice);
      this.directory.delete(userId);
      if (this.linked)
        await this.applyTrust(this.backup).catch((error) =>
          console.error("[e2ee] couldn't read the synced verifications", error),
        );
      await this.publishServerRecovery().catch(() => {});
    }
    async applyTrust(record, syncLocal = true) {
      const trust = record?.identity_key === this.serverKey ? record.trust : undefined;
      if (!trust || !this.secret || trust.version === this.trustVersion) return {};
      this.trustVersion = trust.version;
      const remote = trust.data ? await openTrust(this.secret, this.userId, trust.data) : {};
      let changed = false;
      for (const [userId, entry] of Object.entries(remote)) {
        const contact = this.contacts[userId];
        if (userId === this.userId || entry.at <= (contact?.verifiedAt ?? 0)) continue;
        if (!contact)
          this.contacts[userId] = {
            identityKey: entry.key,
            verified: entry.verified,
            pendingKey: null,
            firstSeen: Date.now(),
            verifiedAt: entry.at,
          };
        else if (contact.identityKey === entry.key)
          Object.assign(contact, { verified: entry.verified, verifiedAt: entry.at });
        else if (contact.pendingKey === entry.key)
          Object.assign(contact, {
            previousKeys: [
              ...new Set([...(contact.previousKeys ?? []), contact.identityKey]),
            ].slice(-16),
            identityKey: entry.key,
            pendingKey: null,
            verified: entry.verified,
            verifiedAt: entry.at,
          });
        else continue;
        this.directory.delete(userId);
        changed = true;
      }
      if (changed) {
        await this.saveContacts();
        queueMicrotask(() => this.emit());
      }
      const unsynced = Object.keys(this.contacts).filter(
        (id) => this.contacts[id].verified && !this.contacts[id].pendingKey && !remote[id],
      );
      if (syncLocal && unsynced.length)
        queueMicrotask(() =>
          this.pushTrust(unsynced).catch((error) =>
            console.error("[e2ee] couldn't sync verifications", error),
          ),
        );
      return remote;
    }
    async syncTrust() {
      if (!this.linked) return;
      await this.serialized(async () => {
        this.backup = await this.fetchBackup();
        await this.applyTrust(this.backup);
      });
    }
    async pushTrust(userIds) {
      if (!this.secret) return;
      await this.serialized(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const backup = (this.backup = await this.fetchBackup());
          if (!backup?.trust || backup.identity_key !== this.serverKey || !this.secret) return;
          this.trustVersion = -1;
          const remote = await this.applyTrust(backup, false).catch(() => ({}));
          const next = { ...remote };
          for (const id of userIds) {
            const contact = this.contacts[id];
            if (!contact || contact.pendingKey) continue;
            const at = contact.verifiedAt ?? Date.now();
            if ((remote[id]?.at ?? 0) < at)
              next[id] = { key: contact.identityKey, verified: contact.verified, at };
          }
          if (userIds.every((id) => next[id] === remote[id])) return;
          try {
            const saved = await this.api.request("put", "/users/@me/e2ee/backup/trust", {
              version: backup.trust.version,
              data: await sealTrust(this.secret, this.userId, next),
            });
            this.trustVersion = saved.version;
            backup.trust = saved;
            return;
          } catch (error) {
            if (error?.status !== 409) throw error;
          }
        }
      });
    }
    async unlockWith(kind, input) {
      const backup = (this.backup = await this.fetchBackup());
      if (
        kind === "password" &&
        (!backup || (backup.mode === "password" && !backup.wrapped_secret))
      )
        throw new E2eeError("BAD_SECRET", t("Your keys aren't backed up with your password yet."));
      if (!backup?.wrapped_secret || backup.mode !== kind)
        throw new E2eeError("BAD_SECRET", t("There's no backup to unlock with that"));
      const secret = await unwrapSecret(this.userId, backup, input).catch(() => null);
      if (!secret)
        throw new E2eeError(
          "BAD_SECRET",
          kind === "password"
            ? t("That password didn't unlock your keys")
            : t("That recovery code didn't work"),
        );
      await this.unlockWithSecret(secret);
    }
    async unlockWithSecret(secret) {
      const backup = await this.fetchBackup();
      if (!backup || backup.identity_key !== this.serverKey)
        throw new E2eeError("BAD_SECRET", t("That key didn't unlock this browser"));
      await this.restoreFromSecret(secret, backup);
      await this.refresh();
      if (!this.linked) throw new E2eeError("BAD_SECRET", t("That key didn't unlock this browser"));
    }
    exportSecret() {
      return this.secret;
    }
    async useRecoveryCode() {
      const code = generateRecoveryCode();
      await this.setBackupMode("recovery", code);
      return code;
    }
    async setBackupMode(mode, input) {
      if (!this.secret) throw new E2eeError("LOCKED", t("Unlock this browser first"));
      await this.serialized(async () => {
        const backup = (this.backup = await this.fetchBackup());
        if (!backup) throw new E2eeError("LOCKED", t("There's no backup yet"));
        this.backup = await this.api.request("patch", "/users/@me/e2ee/backup", {
          version: backup.version,
          ...(await wrapSecret(this.userId, mode, input, this.secret)),
        });
      });
      await this.publishServerRecovery().catch(() => {});
      this.emit();
    }
    async reset(password) {
      await this.serialized(() =>
        this.exclusive(async () => {
          const identityJwk = await generateExportable("Ed25519");
          await this.api.request("post", "/users/@me/e2ee/reset", {
            password,
            public_key: identityJwk.x,
          });
          await this.wipeLocal(false);
          await this.adoptIdentity(identityJwk);
          this.freshIdentity = identityJwk;
          this.backup = null;
          this.holdPassword(password);
          this.directory.clear();
        }),
      );
      await this.refresh();
    }
    async removeDevice(deviceId) {
      await this.api.request("del", `/users/@me/e2ee/devices/${deviceId}`);
      this.devices = this.devices.filter((d) => d.device_id !== deviceId);
      this.directory.delete(this.userId);
      this.emit();
    }
    async reloadBackup() {
      this.backup = await this.fetchBackup();
      this.emit();
      return this.backup;
    }
    invalidateUser(userId) {
      this.directory.delete(userId);
    }
    invalidateChannel(channelId) {
      this.members.delete(channelId);
    }
    invalidateAll() {
      this.directory.clear();
      this.members.clear();
    }
    setChannelEncrypted(channelId) {
      this.encryptedChannels.add(channelId);
      this.emit();
    }
    isEncrypted(channelId) {
      return (
        this.encryptedChannels.has(channelId) ||
        this.classifyChannel(channelId, this.privateByDefault)
      );
    }
    channelMembers(channelId) {
      let pending = this.members.get(channelId);
      if (!pending) {
        pending = this.api
          .request("post", "/e2ee/keys/query", { channel_id: channelId })
          .then((res) => {
            const ids = res.channel_members ?? [];
            for (const id of ids) {
              const entry = this.verifyEntry(
                id,
                res.users[id] ?? { identity_key: null, devices: [] },
              );
              entry.catch(() => this.directory.delete(id));
              this.directory.set(id, entry);
            }
            return ids.filter((id) => id !== this.userId);
          });
        pending.catch(() => this.members.delete(channelId));
        this.members.set(channelId, pending);
      }
      return pending;
    }
    profile(userId) {
      let pending = this.profiles.get(userId);
      if (!pending) {
        pending = this.api
          .request("get", `/users/${userId}`)
          .catch(() => ({ id: userId, username: userId }));
        this.profiles.set(userId, pending);
      }
      return pending;
    }
    async keysFor(userIds, force = false) {
      const missing = [...new Set(userIds)].filter((id) => force || !this.directory.has(id));
      if (missing.length) {
        const batch = this.api.request("post", "/e2ee/keys/query", { user_ids: missing });
        for (const id of missing) {
          const entry = batch.then((res) =>
            this.verifyEntry(id, res.users[id] ?? { identity_key: null, devices: [] }),
          );
          entry.catch(() => this.directory.delete(id));
          this.directory.set(id, entry);
        }
      }
      const entries = await Promise.all(userIds.map((id) => this.directory.get(id)));
      const stale = entries
        .filter((e) => Date.now() - e.fetchedAt > DIRECTORY_TTL_MS)
        .map((e) => e.userId);
      return stale.length && !force ? this.keysFor(userIds, true) : entries;
    }
    async verifyEntry(userId, keys) {
      const identityKey = keys.identity_key;
      let identityChanged = false;
      if (identityKey && userId === this.userId) identityChanged = identityKey !== this.trustedKey;
      else if (identityKey) {
        const contact = this.contacts[userId];
        const previous = keys.previous_identity;
        if (!contact) {
          this.contacts[userId] = {
            identityKey,
            verified: false,
            pendingKey: null,
            firstSeen: Date.now(),
          };
          await this.saveContacts();
        } else if (
          contact.identityKey !== identityKey &&
          previous?.public_key === contact.identityKey &&
          (await verify(
            previous.public_key,
            rotationMessage(userId, previous.public_key, identityKey),
            previous.signature,
          ))
        ) {
          contact.previousKeys = [
            ...new Set([...(contact.previousKeys ?? []), contact.identityKey]),
          ].slice(-16);
          contact.identityKey = identityKey;
          contact.pendingKey = null;
          await this.saveContacts();
        } else if (
          this.trustsServer &&
          (contact.identityKey !== identityKey || contact.pendingKey)
        ) {
          if (contact.identityKey !== identityKey) {
            contact.previousKeys = [
              ...new Set([...(contact.previousKeys ?? []), contact.identityKey]),
            ].slice(-16);
            contact.verified = false;
          }
          contact.identityKey = identityKey;
          contact.pendingKey = null;
          await this.saveContacts();
          queueMicrotask(() => this.emit());
        } else if (contact.identityKey !== identityKey) {
          if (contact.pendingKey !== identityKey) {
            contact.pendingKey = identityKey;
            contact.verified = false;
            await this.saveContacts();
            queueMicrotask(() => this.emit());
          }
          identityChanged = true;
        }
      }
      const devices = [];
      let backupKey = null;
      if (identityKey) {
        const known = this.knownKeys(userId, identityKey);
        for (const device of keys.devices) {
          if (!device.identity_signature) continue;
          if ((await deviceIdFor(device.signing_key)) !== device.device_id) continue;
          const message = deviceMessage(userId, device.device_id, device.signing_key);
          const signers = device.status === "revoked" ? known : [identityKey];
          let signed = false;
          for (const key of signers)
            if (!signed) signed = await verify(key, message, device.identity_signature);
          if (!signed) continue;
          if (
            !(await verify(
              device.signing_key,
              prekeyMessage(device.device_id, device.prekey.id, device.prekey.public_key),
              device.prekey.signature,
            ))
          )
            continue;
          devices.push({
            deviceId: device.device_id,
            signingKey: device.signing_key,
            status: device.status,
            name: device.name,
            prekeyId: device.prekey.id,
            prekeyPublic: device.prekey.public_key,
            revokedAt: device.revoked_at ? Date.parse(device.revoked_at) : null,
          });
        }
        const backup = keys.backup_key;
        if (
          backup &&
          (await verify(identityKey, backupKeyMessage(userId, backup.public_key), backup.signature))
        )
          backupKey = backup.public_key;
      }
      const identityCreatedAt = keys.identity_created_at
        ? Date.parse(keys.identity_created_at)
        : null;
      return {
        userId,
        identityKey,
        identityCreatedAt,
        identityChanged,
        backupKey,
        devices,
        fetchedAt: Date.now(),
      };
    }
    knownKeys(userId, current) {
      if (userId === this.userId)
        return [current, this.trustedKey, ...this.previousIdentities].filter((key) => !!key);
      const contact = this.contacts[userId];
      return [current, contact?.identityKey, ...(contact?.previousKeys ?? [])].filter(
        (key) => !!key,
      );
    }
    async acceptIdentity(userId) {
      const contact = this.contacts[userId];
      if (!contact?.pendingKey) return;
      contact.previousKeys = [
        ...new Set([...(contact.previousKeys ?? []), contact.identityKey]),
      ].slice(-16);
      contact.identityKey = contact.pendingKey;
      contact.pendingKey = null;
      contact.verified = false;
      contact.verifiedAt = Date.now();
      await this.saveContacts();
      this.directory.delete(userId);
      this.emit();
      this.pushTrust([userId]).catch((error) =>
        console.error("[e2ee] couldn't sync the accepted safety number", error),
      );
    }
    async setVerified(userId, verified) {
      const contact = this.contacts[userId];
      if (!contact) return;
      contact.verified = verified;
      contact.verifiedAt = Date.now();
      await this.saveContacts();
      this.emit();
      this.pushTrust([userId]).catch((error) =>
        console.error("[e2ee] couldn't sync the verification", error),
      );
    }
    async encrypt(channelId, payload, opts) {
      if (!this.device || !this.userId)
        throw new E2eeError("NOT_READY", t("Encryption is still starting up"));
      if (!this.linked)
        throw new E2eeError(
          "NOT_LINKED",
          t("This browser isn't unlocked for encrypted messages yet"),
        );
      const members = [this.userId, ...(await this.channelMembers(channelId))];
      const entries = await this.keysFor(members);
      const targets = [];
      for (const entry of entries) {
        if (entry.identityChanged)
          throw new E2eeError("IDENTITY_CHANGED", "A safety number changed", entry.userId);
        const active = entry.devices.filter((d) => d.status === "active");
        if (!active.length)
          throw new E2eeError("NO_DEVICES", "A member has no encryption keys yet", entry.userId);
        active.forEach((device) => targets.push({ userId: entry.userId, device }));
      }
      if (!targets.some((t) => t.device.deviceId === this.device.deviceId)) {
        const current = this.currentPrekey();
        targets.push({
          userId: this.userId,
          device: {
            deviceId: this.device.deviceId,
            signingKey: this.device.signingKey,
            status: "active",
            name: null,
            prekeyId: current.id,
            prekeyPublic: current.publicKey,
            revokedAt: null,
          },
        });
      }
      const bind = binding(opts.mid, opts.nonce);
      const aad = messageAad(channelId, this.userId, this.device.deviceId, bind);
      const contentKey = randomBytes(32);
      const iv = randomBytes(12);
      const ct = await aesEncrypt(contentKey, iv, utf8(JSON.stringify(payload)), aad);
      const keys = await Promise.all(
        targets.map(async ({ userId, device }) => ({
          user_id: userId,
          device_id: device.deviceId,
          prekey_id: device.prekeyId,
          ...(await hpkeSeal(
            device.prekeyPublic,
            contentKey,
            WRAP_INFO,
            `${aad}
${device.deviceId}`,
          )),
        })),
      );
      const backup = await Promise.all(
        entries
          .filter((e) => e.backupKey)
          .map(async (e) => ({
            user_id: e.userId,
            ...(await hpkeSeal(
              e.backupKey,
              contentKey,
              BACKUP_INFO,
              `${aad}
backup:${e.userId}`,
            )),
          })),
      );
      const unsigned = {
        v: 1,
        alg: ALGORITHM,
        sender_device: this.device.deviceId,
        ...(opts.mid ? { mid: opts.mid } : {}),
        iv: toB64u(iv),
        ct: toB64u(ct),
        keys,
        ...(backup.length ? { backup } : {}),
      };
      const sig = await sign(
        this.device.privateKey,
        signedPayload(channelId, this.userId, bind, unsigned),
      );
      const envelope = { ...unsigned, sig };
      this.plaintext.set(
        `${opts.mid ?? ""}:${sig}`,
        parsePayload(JSON.parse(JSON.stringify(payload))),
      );
      return envelope;
    }
    cached(message) {
      const env = message.encrypted;
      return env
        ? (this.plaintext.get(`${message.id}:${env.sig}`) ??
            this.plaintext.get(`${env.mid ?? ""}:${env.sig}`))
        : undefined;
    }
    async decrypt(message, remember = true) {
      const env = message.encrypted;
      if (!env || env.v !== 1 || env.alg !== ALGORITHM || !Array.isArray(env.keys))
        throw new E2eeError("BAD_ENVELOPE", "Unsupported envelope");
      const hit = this.cached(message);
      if (remember && hit !== undefined) {
        this.plaintext.set(`${message.id}:${env.sig}`, hit);
        return hit;
      }
      if (!this.device) throw new E2eeError("NOT_READY", t("Encryption is still starting up"));
      const senderId = message.author?.id;
      if (!senderId) throw new E2eeError("BAD_ENVELOPE", "Missing author");
      if (env.mid && env.mid !== message.id)
        throw new E2eeError("BAD_ENVELOPE", "Envelope belongs to another message");
      const nonce = message.nonce == null ? undefined : String(message.nonce);
      if (!env.mid && !nonce) throw new E2eeError("BAD_ENVELOPE", "Missing nonce");
      let [entry] = await this.keysFor([senderId]);
      let sender = entry.devices.find((d) => d.deviceId === env.sender_device);
      if (!sender && Date.now() - entry.fetchedAt > 3000) {
        [entry] = await this.keysFor([senderId], true);
        sender = entry.devices.find((d) => d.deviceId === env.sender_device);
      }
      const sentAt = snowflakeTime(message.id);
      if (!sender) {
        if (entry.identityCreatedAt && sentAt < entry.identityCreatedAt)
          throw new E2eeError("RESET", t("Sent before encryption was reset"));
        throw new E2eeError("BAD_SIGNATURE", t("The sender's device couldn't be verified"));
      }
      if (sender.status === "revoked" && (!sender.revokedAt || sentAt >= sender.revokedAt))
        throw new E2eeError("BAD_SIGNATURE", t("Sent from a device that was removed"));
      const bind = binding(env.mid, nonce);
      const { sig, ...unsigned } = env;
      if (
        !(await verify(
          sender.signingKey,
          signedPayload(message.channel_id, senderId, bind, unsigned),
          sig,
        ))
      )
        throw new E2eeError("BAD_SIGNATURE", t("Signature check failed"));
      const aad = messageAad(message.channel_id, senderId, env.sender_device, bind);
      const mine = env.keys.find((k) => k.device_id === this.device.deviceId);
      const prekey = mine && this.prekeys.find((p) => p.id === mine.prekey_id);
      let contentKey = null;
      if (mine && prekey)
        contentKey = await hpkeOpen(
          prekey.keyPair,
          mine.enc,
          mine.wrapped,
          WRAP_INFO,
          `${aad}
${mine.device_id}`,
        );
      const backupEntry = env.backup?.find((b) => b.user_id === this.userId);
      const backupKey = this.backupKeyPair;
      if (!contentKey && backupEntry && backupKey)
        contentKey = await hpkeOpen(
          backupKey.keyPair,
          backupEntry.enc,
          backupEntry.wrapped,
          BACKUP_INFO,
          `${aad}
backup:${this.userId}`,
        ).catch(() => null);
      if (!contentKey && backupKey) {
        const stored = await this.lookupStoredKey(message.id);
        if (stored)
          contentKey = await hpkeOpen(
            backupKey.keyPair,
            stored.enc,
            stored.wrapped,
            BACKUP_INFO,
            storedKeyAad(this.userId, message.id, sig),
          ).catch(() => null);
      }
      if (!contentKey) {
        if (!this.linked || !backupKey)
          throw new E2eeError("LOCKED", t("This browser isn't unlocked yet"));
        if (this.identityCreatedAt && sentAt < this.identityCreatedAt)
          throw new E2eeError("RESET", t("Sent before encryption was reset"));
        throw new E2eeError("NO_KEY", t("Sent before this browser was set up"));
      }
      const payload = parsePayload(
        JSON.parse(fromUtf8(await aesDecrypt(contentKey, fromB64u(env.iv), fromB64u(env.ct), aad))),
      );
      if (mine && prekey && backupKey) {
        const covered =
          !!backupEntry &&
          !!(await hpkeOpen(
            backupKey.keyPair,
            backupEntry.enc,
            backupEntry.wrapped,
            BACKUP_INFO,
            `${aad}
backup:${this.userId}`,
          ).catch(() => null));
        if (!covered) await this.queueBackup(message.id, sig, contentKey);
      }
      if (remember) this.plaintext.set(`${message.id}:${env.sig}`, payload);
      return payload;
    }
    lookupStoredKey(messageId) {
      const known = this.storedKeys.get(messageId);
      if (known) return Promise.resolve(known);
      const existing = this.lookups.get(messageId);
      if (existing) return existing.promise;
      let resolve = () => {};
      const promise = new Promise((r) => {
        resolve = r;
      });
      this.lookups.set(messageId, { promise, resolve });
      this.lookupTimer ??= setTimeout(() => this.flushLookups(), 25);
      return promise;
    }
    async flushLookups() {
      this.lookupTimer = null;
      const batch = [...this.lookups.entries()].slice(0, 100);
      batch.forEach(([id]) => this.lookups.delete(id));
      if (this.lookups.size) this.lookupTimer = setTimeout(() => this.flushLookups(), 0);
      try {
        const res = await this.api.request("post", "/users/@me/e2ee/backup/keys/query", {
          message_ids: batch.map(([id]) => id),
        });
        for (const key of res.keys)
          this.storedKeys.set(key.message_id, {
            user_id: this.userId,
            enc: key.enc,
            wrapped: key.wrapped,
          });
      } catch (error) {
        console.error("[e2ee] backup key lookup failed", error);
      }
      batch.forEach(([id, { resolve }]) => resolve(this.storedKeys.get(id) ?? null));
    }
    async queueBackup(messageId, sig, contentKey) {
      const marker = `bk:${messageId}`;
      if (
        this.uploads.has(messageId) ||
        (await this.store.get(marker)) === sig ||
        !this.backupKeyPair
      )
        return;
      const sealed = await hpkeSeal(
        this.backupKeyPair.publicKey,
        contentKey,
        BACKUP_INFO,
        storedKeyAad(this.userId, messageId, sig),
      );
      this.uploads.set(messageId, { message_id: messageId, ...sealed, sig });
      this.uploadTimer ??= setTimeout(() => this.flushBackups(), 1000);
    }
    async flushBackups() {
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.uploadTimer = null;
      while (this.uploads.size) {
        const batch = [...this.uploads.values()].slice(0, 100);
        batch.forEach((entry) => this.uploads.delete(entry.message_id));
        try {
          await this.api.request("post", "/users/@me/e2ee/backup/keys", {
            keys: batch.map(({ message_id, enc, wrapped }) => ({ message_id, enc, wrapped })),
          });
          await Promise.all(
            batch.map((entry) => this.store.set(`bk:${entry.message_id}`, entry.sig)),
          );
        } catch (error) {
          console.error("[e2ee] backup upload failed", error);
          return;
        }
      }
    }
    async backfill() {
      const key = this.backupKeyPair?.publicKey;
      if (!key || this.backfilling) return;
      const marker = `backfill:${key}`;
      if (await this.store.get(marker)) return;
      this.backfilling = true;
      try {
        for (const channelId of [...this.encryptedChannels]) {
          let before = "";
          for (let page = 0; page < 50; page++) {
            const batch = await this.api.request(
              "get",
              `/channels/${channelId}/messages?limit=100${before && `&before=${before}`}`,
            );
            for (const message of batch)
              if (message.encrypted) await this.decrypt(message, false).catch(() => {});
            await this.flushBackups();
            if (batch.length < 100) break;
            before = batch[batch.length - 1].id;
            await sleep(250);
          }
        }
        await this.store.set(marker, true);
      } finally {
        this.backfilling = false;
      }
    }
    async safetyNumber(userId) {
      const [entry] = await this.keysFor([userId]);
      const theirs = this.contacts[userId]?.pendingKey ?? entry.identityKey;
      const mine = this.trustedKey;
      if (!theirs || !mine) return null;
      const part = async (id, key) => {
        let digest = new Uint8Array(
          await crypto.subtle.digest(
            "SHA-512",
            new Uint8Array([0, 0, ...fromB64u(key), ...utf8(id)]),
          ),
        );
        for (let i = 0; i < 5200; i++)
          digest = new Uint8Array(
            await crypto.subtle.digest("SHA-512", new Uint8Array([...digest, ...fromB64u(key)])),
          );
        let out = "";
        for (let i = 0; i < 30; i += 5) {
          const chunk = digest.subarray(i, i + 5).reduce((acc, byte) => acc * 256 + byte, 0);
          out += String(chunk % 1e5).padStart(5, "0");
        }
        return out;
      };
      const [own, other] = await Promise.all([part(this.userId, mine), part(userId, theirs)]);
      return own < other ? own + other : other + own;
    }
  }

  // client/e2ee/src/hooks.ts
  var DECRYPTING_CONTENT = "Decrypting…";
  var MISSING_CONTENT = "Sent before this browser was set up";
  var LOCKED_CONTENT = "Unlock this browser to read this message";
  var RESET_CONTENT = "Sent before encryption was reset";
  var FAILED_CONTENT = "This message couldn't be decrypted";
  var decryptingContent = () => t(DECRYPTING_CONTENT);
  var contentFor = (state, fallback, trustsServer = false) =>
    state === "missing"
      ? t(MISSING_CONTENT)
      : state === "locked"
        ? t(trustsServer ? "Preparing private chat…" : LOCKED_CONTENT)
        : state === "reset"
          ? t(RESET_CONTENT)
          : state === "failed"
            ? t(FAILED_CONTENT)
            : fallback;
  var SEARCH_URL = /^\/channels\/(\d+)\/messages\/search(\/tabs)?$/;
  var SEARCH_PAGES = 10;
  var AUTH_URL = /^\/auth\/(login|register)$/;
  var MESSAGE_URL = /^\/channels\/(\d+)\/messages(?:\/(\d+))?$/;
  var CREATE_ATTACHMENTS_URL = /^\/channels\/(\d+)\/attachments$/;
  var isEncryptedMessage = (value) => {
    const message = value;
    return (
      !!message &&
      typeof message === "object" &&
      !!message.encrypted &&
      typeof message.id === "string" &&
      typeof message.channel_id === "string"
    );
  };
  var collect = (value, out, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 6) return out;
    if (Array.isArray(value)) {
      value.forEach((item) => collect(item, out, depth + 1));
      return out;
    }
    if (isEncryptedMessage(value)) out.push(value);
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === "object" && key !== "encrypted") collect(child, out, depth + 1);
    }
    return out;
  };
  var createHooks = (ctx) => {
    const { engine, states } = ctx;
    const inflight = new Map();
    const retry = new Map();
    const readable = new Map();
    const searched = new Map();
    const payloads = new Map();
    let dispatcher = null;
    const clone = (message) => JSON.parse(JSON.stringify(message));
    const remember = (message) => {
      let channel = readable.get(message.channel_id);
      if (!channel) readable.set(message.channel_id, (channel = new Map()));
      channel.set(message.id, clone(message));
    };
    const show = (message, payload) => {
      ctx.attachments.apply(message, payload);
      payloads.set(message.id, payload);
    };
    const previewed = new Map();
    const previews = (message) => {
      try {
        if (localStorage.getItem("fosscord-e2ee-previews") === "0") return;
      } catch {}
      const text = typeof message.content === "string" ? message.content : "";
      const urls = [
        ...new Set(
          (text.match(/<?https?:\/\/[^\s<>]+>?/g) ?? []).filter((u) => !u.startsWith("<")),
        ),
      ].slice(0, 5);
      if (!urls.length) return;
      const apply = (found) => {
        const embeds = urls.flatMap((u) => found[u] ?? previewed.get(u) ?? []);
        if (!embeds.length) return;
        const target = readable.get(message.channel_id)?.get(message.id) ?? clone(message);
        const copy = target;
        copy.embeds = embeds;
        copy.flags = Number(copy.flags ?? 0) & ~4;
        redispatch(copy);
      };
      const missing = urls.filter((u) => !previewed.has(u));
      if (!missing.length) return void setTimeout(() => apply({}), 300);
      ctx
        .fetchEmbeds(missing)
        .then((found) => {
          for (const u of missing) previewed.set(u, found[u] ?? []);
          apply(found);
        })
        .catch(() => {});
    };
    const soundCache = new Map();
    const soundmoji = async (message) => {
      const text = typeof message.content === "string" ? message.content : "";
      const refs = [
        ...new Set(
          [...text.matchAll(/<sound:(\d+):(\d+)>/g)].map(([, guild, sound]) => `${guild}:${sound}`),
        ),
      ].slice(0, 25);
      if (!refs.length) return;
      const soundId = (ref) => ref.split(":")[1];
      const missing = refs.filter((ref) => !soundCache.has(soundId(ref)));
      if (missing.length) {
        try {
          for (const sound of await ctx.fetchSoundmoji(missing))
            if (sound?.sound_id) soundCache.set(String(sound.sound_id), sound);
          for (const ref of missing)
            if (!soundCache.has(soundId(ref))) soundCache.set(soundId(ref), null);
        } catch {}
      }
      const sounds = refs.map((ref) => soundCache.get(soundId(ref))).filter(Boolean);
      if (!sounds.length) return;
      message.soundboard_sounds = sounds;
      setTimeout(() => ctx.updateRecord(message), 400);
    };
    const decryptOne = (message) => {
      const key = `${message.id}:${message.encrypted?.sig}`;
      const sync = engine.cached(message);
      if (sync !== undefined) {
        show(message, sync);
        states.set(message.id, { state: "decrypted" });
        retry.delete(message.id);
        return soundmoji(message).then(() => {
          remember(message);
          previews(message);
        });
      }
      if (!ctx.isReady()) {
        if (ctx.failClosed()) {
          states.set(message.id, {
            state: "failed",
            reason: t("Encryption is unavailable in this client build"),
          });
          message.content = t(FAILED_CONTENT);
        } else {
          retry.set(message.id, clone(message));
          states.set(message.id, { state: "pending" });
          message.content = decryptingContent();
        }
        return Promise.resolve();
      }
      let pending = inflight.get(key);
      if (!pending) {
        const original = clone(message);
        pending = (async () => {
          try {
            const payload = await engine.decrypt(message);
            states.set(message.id, { state: "decrypted" });
            retry.delete(message.id);
            show(message, payload);
            await soundmoji(message);
            remember(message);
            previews(message);
          } catch (error) {
            const code = error instanceof E2eeError ? error.code : null;
            const state =
              code === "LOCKED"
                ? "locked"
                : code === "NO_KEY"
                  ? "missing"
                  : code === "RESET"
                    ? "reset"
                    : "failed";
            states.set(message.id, { state, reason: errorText(error) });
            if (state === "locked" || state === "missing") retry.set(message.id, original);
            message.content = contentFor(state, undefined, engine.trustsServer);
          }
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
        return pending.then(() => ctx.onState());
      }
      return pending.then(() => {
        const again = engine.cached(message);
        const state = states.get(message.id)?.state;
        if (again) show(message, again);
        else message.content = contentFor(state, message.content, engine.trustsServer);
        ctx.onState();
      });
    };
    const redispatch = (copy) => {
      dispatcher?.dispatch({ type: "MESSAGE_UPDATE", message: copy, e2eeLocal: true });
      if (states.get(copy.id)?.state === "decrypted") ctx.updateRecord(copy);
    };
    const retryAll = () => {
      if (!ctx.isReady()) return;
      const queued = [...retry.values()];
      retry.clear();
      for (const copy of queued) {
        const before = states.get(copy.id)?.state;
        decryptOne(copy).then(() => {
          const after = states.get(copy.id)?.state;
          if (after === before && after !== "pending") return;
          redispatch(copy);
          ctx.onState();
        });
      }
    };
    const decryptAll = async (value) => {
      const messages = collect(value, []);
      if (messages.length) await Promise.all(messages.map(decryptOne));
    };
    const encryptBody = async (method, opts) => {
      const match = MESSAGE_URL.exec(opts.url.split("?")[0]);
      if (!match || (method !== "post" && method !== "patch")) return opts;
      const [, channelId, messageId] = match;
      if (method === "post" && messageId) return opts;
      if (!engine.isEncrypted(channelId)) return opts;
      if (ctx.failClosed())
        throw new E2eeError("NOT_READY", t("Encryption is unavailable in this client build"));
      if (!(await ctx.ready))
        throw new E2eeError("NOT_READY", t("Encryption is unavailable in this client build"));
      const body = { ...(opts.body ?? {}) };
      if (method === "patch" && body.content === undefined && body.attachments === undefined)
        return opts;
      if (body.poll)
        throw new E2eeError("UNSUPPORTED", t("Polls can't be sent in encrypted conversations yet"));
      if (opts.attachments?.length)
        throw new E2eeError("UNSUPPORTED", t("This file couldn't be encrypted"));
      const nonce =
        method === "post"
          ? String(body.nonce ?? `${Date.now()}${Math.floor(Math.random() * 1000)}`)
          : undefined;
      if (nonce) body.nonce = nonce;
      const payload = { content: String(body.content ?? "") };
      const refs = Array.isArray(body.attachments) ? body.attachments : [];
      if (method === "post") {
        const metas = refs.map((ref) => ctx.attachments.metaFor(ref));
        if (metas.some((meta) => !meta))
          throw new E2eeError("UNSUPPORTED", t("A file wasn't encrypted before it was uploaded"));
        if (metas.length) {
          payload.attachments = metas.map((meta) => meta);
          body.attachments = refs.map((ref, i) => ({
            id: ref.id,
            filename: metas[i].name,
            uploaded_filename: ref.uploaded_filename,
          }));
        }
        const stickers = Array.isArray(body.sticker_ids) ? body.sticker_ids.map(String) : [];
        if (stickers.length)
          payload.stickers = stickers.map(
            (id) => ctx.sticker(id) ?? { id, name: "", format_type: 1 },
          );
        delete body.sticker_ids;
      } else {
        const previous = payloads.get(messageId);
        if (!previous)
          throw new E2eeError("NOT_READY", t("This message isn't decrypted in this browser yet"));
        if (body.content === undefined) payload.content = previous.content;
        let kept = previous.attachments;
        if (Array.isArray(body.attachments)) {
          const names = refs.map((ref) => ctx.attachments.nameOf(String(ref.id)));
          kept = kept?.filter((meta) => names.includes(meta.name));
          body.attachments = refs.map((ref, i) => ({
            id: ref.id,
            filename: names[i] ?? "file.bin",
          }));
        }
        if (kept?.length) payload.attachments = kept;
        if (previous.stickers?.length) payload.stickers = previous.stickers;
      }
      body.encrypted = await engine.encrypt(channelId, payload, {
        nonce,
        mid: method === "patch" ? messageId : undefined,
      });
      body.content = FALLBACK_CONTENT;
      return { ...opts, body };
    };
    const searchLocally = async (originals, channelId, queries) => {
      if (Date.now() - (searched.get(channelId) ?? 0) > 60000) {
        let before = "";
        for (let page = 0; page < SEARCH_PAGES; page++) {
          const res = await originals
            .get({
              url: `/channels/${channelId}/messages`,
              query: { limit: 100, ...(before && { before }) },
              rejectWithError: false,
            })
            .catch(() => null);
          const batch = res?.ok ? res.body : [];
          await decryptAll(batch);
          if (batch.length < 100) break;
          before = batch[batch.length - 1].id;
        }
        searched.set(channelId, Date.now());
      }
      const all = [...(readable.get(channelId)?.values() ?? [])]
        .filter((m) => states.get(m.id)?.state === "decrypted")
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      return queries.map((query) => {
        const words = String(query.content ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const authors = [query.author_id ?? []].flat().map(String);
        const hits = all.filter((m) => {
          const text = String(m.content ?? "").toLowerCase();
          return (
            words.every((w) => text.includes(w)) &&
            (!authors.length || authors.includes(String(m.author?.id)))
          );
        });
        if (query.sort_order === "asc") hits.reverse();
        const offset = Number(query.offset ?? 0) || 0;
        const limit = Number(query.limit ?? 25) || 25;
        return {
          analytics_id: null,
          doing_deep_historical_index: false,
          total_results: hits.length,
          messages: hits.slice(offset, offset + limit).map((m) => [{ ...m, hit: true }]),
          threads: [],
          members: [],
        };
      });
    };
    const wrapHttp = (http) => {
      const originals = { ...http };
      for (const method of ["get", "post", "put", "patch", "del"]) {
        const original = originals[method];
        const wrapped = (input, callback) => {
          const opts = typeof input === "string" ? { url: input, rejectWithError: false } : input;
          const url = typeof opts?.url === "string" ? opts.url : "";
          const path = url.split("?")[0];
          if (method === "post" && path === "/auth/logout") ctx.onLogout();
          if (
            (method === "post" && AUTH_URL.test(path)) ||
            (method === "patch" && path === "/users/@me")
          ) {
            const body = opts.body ?? {};
            const result = original(input, callback);
            result.then(
              (res) => res?.ok && ctx.onCredentials(path, body, res.body),
              () => {},
            );
            return result;
          }
          if (method === "put" && ctx.attachments.isUpload(url)) {
            const upload = (async () => {
              const prepared = await ctx.attachments.prepareUpload(opts);
              const result = await original(prepared, callback);
              if (result?.ok) ctx.attachments.uploaded(url);
              return result;
            })();
            upload.catch(() => {});
            return upload;
          }
          const create = method === "post" ? CREATE_ATTACHMENTS_URL.exec(path) : null;
          if (create && engine.isEncrypted(create[1])) {
            const created = (async () => {
              if (ctx.failClosed() || !(await ctx.ready)) {
                const error = new E2eeError(
                  "NOT_READY",
                  t("Encryption is unavailable in this client build"),
                );
                ctx.onError(error, create[1]);
                throw error;
              }
              const { body, track } = ctx.attachments.prepareCreate(opts.body ?? {});
              const headers = Object.fromEntries(
                Object.entries(opts.headers ?? {}).filter(([name]) => !/md5/i.test(name)),
              );
              const result = await original({ ...opts, body, headers }, callback);
              if (result?.ok) track(result.body);
              return result;
            })();
            created.catch(() => {});
            return created;
          }
          const relevant =
            url.startsWith("/channels/") ||
            url.startsWith("/users/@me/mentions") ||
            url.includes("/messages");
          if (!relevant) return original(input, callback);
          const search = SEARCH_URL.exec(path);
          if (
            search &&
            engine.isEncrypted(search[1]) &&
            (method === "get" || (method === "post" && search[2]))
          ) {
            const [, channelId, tabs] = search;
            return (async () => {
              const params = new URLSearchParams(url.split("?")[1] ?? "");
              const extra = opts.query;
              if (typeof extra === "string")
                new URLSearchParams(extra).forEach((value, name) => params.append(name, value));
              else if (extra && typeof extra === "object")
                Object.entries(extra).forEach(([name, value]) =>
                  [value].flat().forEach((v) => v != null && params.append(name, String(v))),
                );
              const query = {
                content: params.get("content") ?? undefined,
                author_id: params.getAll("author_id"),
                offset: params.get("offset") ?? undefined,
                limit: params.get("limit") ?? undefined,
                sort_order: params.get("sort_order") ?? undefined,
              };
              const named = tabs ? Object.entries((opts.body ?? {}).tabs ?? {}) : [];
              const results = await searchLocally(
                originals,
                channelId,
                tabs ? named.map(([, q]) => q) : [query],
              );
              const body = tabs
                ? {
                    tabs: Object.fromEntries(
                      named.map(([name], i) => [name, { ...results[i], cursor: null }]),
                    ),
                    analytics_id: null,
                    doing_deep_historical_index: false,
                  }
                : results[0];
              const response = { ok: true, status: 200, body, headers: {} };
              callback?.({ ...response, hasErr: false });
              return response;
            })();
          }
          const pending = (async () => {
            let prepared;
            try {
              prepared = await encryptBody(method, opts);
            } catch (error) {
              const match = MESSAGE_URL.exec(url.split("?")[0]);
              ctx.onError(error, match?.[1] ?? "");
              callback?.({ ok: false, hasErr: true, err: error, status: 0, body: null });
              throw error;
            }
            for (let attempt = 0; ; attempt++) {
              let response;
              try {
                const result = await original(prepared, (res) => (response = res));
                if (prepared !== opts && result?.ok)
                  ctx.attachments.sent((opts.body?.attachments ?? []).filter(Boolean));
                await decryptAll(result?.body);
                callback?.(response ?? { ...result, hasErr: false });
                return result;
              } catch (error) {
                const failure = error;
                if (
                  attempt === 0 &&
                  failure?.status === 409 &&
                  failure.body?.message === "E2EE_DEVICE_MISMATCH" &&
                  prepared !== opts
                ) {
                  const match = MESSAGE_URL.exec(url.split("?")[0]);
                  engine.invalidateChannel(match[1]);
                  engine.invalidateAll();
                  prepared = await encryptBody(method, opts);
                  continue;
                }
                if (response) callback?.(response);
                throw error;
              }
            }
          })();
          pending.catch(() => {});
          return pending;
        };
        http[method] = wrapped;
      }
      return originals;
    };
    const wrapGateway = (store, custom) => {
      const socketDispatcher = store.getSocket().dispatcher;
      let current = socketDispatcher.getDispatchHandler;
      const cache = new Map();
      const wrap = (type) => {
        const base = current?.(type);
        const hit = cache.get(type);
        if (hit && hit.base === base) return hit.wrapped;
        let wrapped = base;
        if (custom[type])
          wrapped = {
            preload: () => null,
            dispatch: (data) => custom[type](data),
          };
        else if (base && (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE")) {
          wrapped = {
            ...base,
            preload: (data) => {
              const own = base.preload(data);
              if (!collect(data, []).length) return own;
              return Promise.all([own, decryptAll(data)]).then(([result]) => result);
            },
            dispatch: (...args) => base.dispatch(...args),
          };
        }
        cache.set(type, { base, wrapped });
        return wrapped;
      };
      Object.defineProperty(socketDispatcher, "getDispatchHandler", {
        configurable: true,
        get: () => (current ? wrap : null),
        set: (value) => {
          current = value;
          cache.clear();
        },
      });
    };
    const watchDispatcher = (target) => {
      dispatcher = target;
      target.addInterceptor((action) => {
        if (action.e2eeLocal || !/MESSAGE|SEARCH|PIN|MENTION|THREAD/.test(action.type))
          return false;
        const messages = collect(action, []).filter(
          (m) => m.content === FALLBACK_CONTENT && !states.has(m.id),
        );
        for (const message of messages) {
          const hit = engine.cached(message);
          if (hit !== undefined) {
            show(message, hit);
            states.set(message.id, { state: "decrypted" });
            remember(message);
            previews(message);
            continue;
          }
          const copy = clone(message);
          message.content = decryptingContent();
          decryptOne(copy).then(() => {
            if (states.get(copy.id)?.state !== "pending") redispatch(copy);
          });
        }
        return false;
      });
    };
    return { wrapHttp, wrapGateway, watchDispatcher, decryptAll, retryAll };
  };

  // client/e2ee/src/link.ts
  var OFFER_WINDOW_MS = 1200;
  var MAX_APPROVERS = 4;
  var sasFor = async (requestId, requester, approver) => {
    const digest = await sha256(
      utf8(`fosscord-e2ee/v1/sas
${requestId}
${requester}
${approver}`),
    );
    const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
    const digits = String(value % 1e6).padStart(6, "0");
    return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  };
  var channelKey = async (pair, peer, requestId) =>
    hkdf(await x25519(pair.privateKey, peer), utf8(requestId), "fosscord-e2ee/v1/link");
  var channelAad = (requestId, requester, approver) => `fosscord-e2ee/v1/link
${requestId}
${requester}
${approver}`;
  var createLink = (engine, api, hooks) => {
    let outgoing = null;
    let remote = null;
    let requesting = null;
    let leader = false;
    let wanted = false;
    let stopped = false;
    let denied = false;
    let release = null;
    let channel = null;
    const incoming = new Map();
    const prompts = new Map();
    const remotePrompts = new Set();
    const responders = new Map();
    const send = (message) => channel?.postMessage(message);
    const snapshot = () =>
      outgoing
        ? {
            requestId: outgoing.requestId,
            state: outgoing.state,
            approvers: [...outgoing.offers.values()].flatMap(({ name, sas }) =>
              sas ? [{ name, sas }] : [],
            ),
            error: outgoing.error,
          }
        : denied
          ? { requestId: "", state: "denied", approvers: [], error: null }
          : null;
    const changed = () => {
      if (leader) send({ type: "outgoing", value: snapshot() });
      hooks.onChange();
    };
    const post = (body) =>
      api.request("post", "/users/@me/e2ee/link", { ...body, device_id: engine.device.deviceId });
    const dismiss = (requestId, error) => {
      prompts.delete(requestId);
      hooks.onDismiss(requestId);
      send({ type: "dismiss", requestId, error });
    };
    const begin = async () => {
      const pair = await generateAgreementKey();
      const publicKey = await exportPublic(pair.publicKey);
      if (!engine.device || engine.linked || stopped) return;
      const current = {
        requestId: toB64u(randomBytes(16)),
        state: "waiting",
        error: null,
        pair,
        publicKey,
        offers: new Map(),
        revealed: false,
        approved: false,
      };
      outgoing = current;
      changed();
      const body = {
        request_id: current.requestId,
        stage: "request",
        name: deviceName(),
        commit: toB64u(await sha256(fromB64u(publicKey))),
      };
      await post(body);
      let attempts = 0;
      const timer = setInterval(() => {
        if (
          outgoing !== current ||
          current.state !== "waiting" ||
          current.offers.size ||
          engine.linked ||
          stopped ||
          ++attempts > 30
        )
          return clearInterval(timer);
        post(body).catch(() => {});
      }, 1e4);
    };
    const request = () => {
      if (stopped || denied) return Promise.resolve();
      wanted = true;
      if (!leader) {
        send({ type: "request" });
        return Promise.resolve();
      }
      if (!engine.device || engine.linked) return Promise.resolve();
      if (requesting) return requesting;
      if (outgoing && (outgoing.state === "waiting" || outgoing.state === "comparing"))
        return Promise.resolve();
      requesting = begin().finally(() => {
        requesting = null;
      });
      return requesting;
    };
    const cancel = async () => {
      wanted = false;
      if (!leader) return void send({ type: "cancel" });
      const current = outgoing;
      if (!current) return;
      outgoing = null;
      changed();
      if (current.state !== "done" && !current.approved && engine.device)
        await post({ request_id: current.requestId, stage: "cancel" }).catch(() => {});
    };
    const forgetOutgoing = () => {
      outgoing = null;
      remote = null;
      changed();
    };
    const reveal = async (current) => {
      if (outgoing !== current || current.revealed || current.state !== "waiting") return;
      current.revealed = true;
      for (const offer of current.offers.values())
        offer.sas = await sasFor(current.requestId, current.publicKey, offer.key);
      current.state = "comparing";
      changed();
      await Promise.all(
        [...current.offers.keys()].map((to) =>
          post({
            request_id: current.requestId,
            stage: "reveal",
            to_device: to,
            public_key: current.publicKey,
          }),
        ),
      );
    };
    const onRequest = async (event) => {
      if (
        !engine.device ||
        event.device_id === engine.device.deviceId ||
        !engine.linked ||
        !engine.exportSecret() ||
        !event.commit
      )
        return;
      if (incoming.has(event.request_id) || incoming.size > 8) return;
      const pair = await generateAgreementKey();
      const publicKey = await exportPublic(pair.publicKey);
      if (incoming.has(event.request_id)) return;
      incoming.set(event.request_id, {
        deviceId: event.device_id,
        name: event.name ?? "a new browser",
        commit: event.commit,
        pair,
        publicKey,
        requester: null,
      });
      setTimeout(
        () => {
          if (incoming.delete(event.request_id) && prompts.has(event.request_id))
            dismiss(event.request_id);
        },
        10 * 60 * 1000,
      );
      await post({
        request_id: event.request_id,
        stage: "offer",
        to_device: event.device_id,
        public_key: publicKey,
      });
    };
    const respond = async (requestId, stage) => {
      const pending = incoming.get(requestId);
      if (!pending?.requester || !incoming.delete(requestId)) return;
      const requester = pending.requester;
      try {
        if (stage === "deny")
          await post({ request_id: requestId, stage, to_device: pending.deviceId });
        else {
          const secret = engine.exportSecret();
          if (!secret) throw new Error(t("This browser can't approve logins"));
          const key = await channelKey(pending.pair, requester, requestId);
          const iv = randomBytes(12);
          const ct = await aesEncrypt(
            key,
            iv,
            secret,
            channelAad(requestId, requester, pending.publicKey),
          );
          await post({
            request_id: requestId,
            stage,
            to_device: pending.deviceId,
            iv: toB64u(iv),
            ct: toB64u(ct),
          });
        }
        dismiss(requestId);
      } catch (error) {
        dismiss(requestId, errorText(error));
        throw error;
      }
    };
    const onResponse = async (event) => {
      const mine = engine.device?.deviceId;
      if (!mine) return;
      if (
        (event.stage === "approve" || event.stage === "deny") &&
        event.device_id !== mine &&
        event.to_device !== mine &&
        incoming.has(event.request_id)
      ) {
        incoming.delete(event.request_id);
        if (prompts.has(event.request_id)) dismiss(event.request_id);
        return;
      }
      if (event.to_device !== mine) return;
      if (event.stage === "invite") {
        if (engine.locked)
          request().catch((error) => console.error("[e2ee] link request failed", error));
        return;
      }
      const current = outgoing?.requestId === event.request_id ? outgoing : null;
      if (
        event.stage === "offer" &&
        current &&
        !current.revealed &&
        event.public_key &&
        !current.offers.has(event.device_id) &&
        current.offers.size < MAX_APPROVERS
      ) {
        const first = !current.offers.size;
        current.offers.set(event.device_id, {
          key: event.public_key,
          name: deviceLabel(engine.devices, event.device_id, t("Your other browser")),
          sas: null,
        });
        if (first)
          setTimeout(
            () => reveal(current).catch((error) => console.error("[e2ee] link", error)),
            OFFER_WINDOW_MS,
          );
        return;
      }
      if (event.stage === "reveal" && event.public_key) {
        const pending = incoming.get(event.request_id);
        if (!pending || pending.deviceId !== event.device_id || pending.requester) return;
        if (toB64u(await sha256(fromB64u(event.public_key))) !== pending.commit) {
          incoming.delete(event.request_id);
          return;
        }
        pending.requester = event.public_key;
        if (!engine.devices.some((d) => d.device_id === pending.deviceId))
          await engine.refresh().catch(() => {});
        const device = engine.devices.find((d) => d.device_id === pending.deviceId);
        const added = device && deviceAdded(deviceTwins(engine.devices, device), device);
        const info = {
          requestId: event.request_id,
          name: (device && deviceTitle(device)) || pending.name,
          detail:
            [added && t("Signed in {date}", { date: added }), device?.session?.location]
              .filter(Boolean)
              .join(" · ") || null,
          sas: await sasFor(event.request_id, event.public_key, pending.publicKey),
          autoApprove: device?.session?.signed_in === true && device.status !== "revoked",
        };
        prompts.set(info.requestId, info);
        send({ type: "prompt", prompt: info });
        hooks.onPrompt({
          ...info,
          approve: () => respond(info.requestId, "approve"),
          deny: () => respond(info.requestId, "deny"),
        });
        return;
      }
      const offer = current?.revealed ? current.offers.get(event.device_id) : undefined;
      if (!current || !offer || current.approved) return;
      if (event.stage === "deny") {
        current.state = "denied";
        denied = true;
        wanted = false;
        changed();
        return;
      }
      if (event.stage === "approve" && event.iv && event.ct) {
        try {
          const key = await channelKey(current.pair, offer.key, current.requestId);
          const secret = await aesDecrypt(
            key,
            fromB64u(event.iv),
            fromB64u(event.ct),
            channelAad(current.requestId, current.publicKey, offer.key),
          );
          current.approved = true;
          current.error = null;
          await engine.unlockWithSecret(secret);
          current.state = "done";
          post({ request_id: current.requestId, stage: "cancel" }).catch(() => {});
        } catch (error) {
          console.error("[e2ee] approval didn't unlock this browser", error);
          current.state = "failed";
          current.error = errorText(error);
        }
        changed();
      }
    };
    const remoteRespond = (requestId, stage) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          responders.delete(requestId);
          reject(new Error("The other tab didn't answer"));
        }, 15000);
        responders.set(requestId, {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        send({ type: "respond", requestId, stage });
      });
    const onTab = (message) => {
      if (stopped) return;
      if (message.type === "dismiss") {
        remotePrompts.delete(message.requestId);
        hooks.onDismiss(message.requestId);
        const responder = responders.get(message.requestId);
        responders.delete(message.requestId);
        if (message.error) responder?.reject(new Error(message.error));
        else responder?.resolve();
        return;
      }
      if (message.type === "unlocked") return hooks.onPeerUnlock();
      if (message.type === "reset") {
        forgetOutgoing();
        return hooks.onPeerReset();
      }
      if (!leader) {
        if (message.type === "outgoing") {
          remote = message.value;
          hooks.onChange();
        } else if (message.type === "prompt" && !remotePrompts.has(message.prompt.requestId)) {
          const { requestId } = message.prompt;
          remotePrompts.add(requestId);
          hooks.onPrompt({
            ...message.prompt,
            approve: () => remoteRespond(requestId, "approve"),
            deny: () => remoteRespond(requestId, "deny"),
          });
        }
        return;
      }
      if (message.type === "hello") {
        send({ type: "outgoing", value: snapshot() });
        prompts.forEach((prompt) => send({ type: "prompt", prompt }));
      } else if (message.type === "request")
        engine
          .refresh()
          .catch((error) => console.error("[e2ee] refresh failed", error))
          .then(() => (engine.linked ? send({ type: "unlocked" }) : request()))
          .catch((error) => console.error("[e2ee] link request failed", error));
      else if (message.type === "cancel") cancel();
      else if (message.type === "respond")
        respond(message.requestId, message.stage).catch((error) =>
          console.error("[e2ee] link", error),
        );
    };
    const becomeLeader = () => {
      if (stopped) return;
      leader = true;
      remotePrompts.forEach((id) => hooks.onDismiss(id));
      remotePrompts.clear();
      const inherited = remote;
      remote = null;
      if (
        engine.locked &&
        (wanted || inherited?.state === "waiting" || inherited?.state === "comparing")
      )
        request().catch((error) => console.error("[e2ee] link request failed", error));
      changed();
    };
    const start = (userId) => {
      if (channel || leader || stopped) return;
      if (typeof BroadcastChannel === "function") {
        channel = new BroadcastChannel(`fosscord-e2ee-link:${userId}`);
        channel.addEventListener("message", (event) => onTab(event.data));
      }
      addEventListener("pagehide", () => {
        const current = outgoing;
        if (
          !leader ||
          !current ||
          current.approved ||
          !engine.device ||
          (current.state !== "waiting" && current.state !== "comparing")
        )
          return;
        hooks.beacon({
          request_id: current.requestId,
          stage: "cancel",
          device_id: engine.device.deviceId,
        });
      });
      if (!navigator.locks || !channel) return becomeLeader();
      navigator.locks.request(`fosscord-e2ee-link:${userId}`, () => {
        if (stopped) return;
        becomeLeader();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      send({ type: "hello" });
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      leader = false;
      outgoing = null;
      remote = null;
      for (const id of [...prompts.keys(), ...remotePrompts]) hooks.onDismiss(id);
      prompts.clear();
      remotePrompts.clear();
      incoming.clear();
      channel?.close();
      channel = null;
      release?.();
      release = null;
      hooks.onChange();
    };
    const devicesChanged = () => {
      const current = outgoing;
      if (
        !leader ||
        !current ||
        current.state !== "comparing" ||
        current.approved ||
        !engine.locked
      )
        return;
      if (
        [...current.offers.keys()].some((id) =>
          engine.devices.some((d) => d.device_id === id && d.status === "active"),
        )
      )
        return;
      outgoing = null;
      changed();
      request().catch((error) => console.error("[e2ee] link request failed", error));
    };
    const invite = async (deviceId) => {
      if (!engine.device || !engine.linked) return;
      await post({ request_id: toB64u(randomBytes(16)), stage: "invite", to_device: deviceId });
    };
    return {
      start,
      stop,
      request,
      cancel,
      invite,
      devicesChanged,
      unlocked: () => send({ type: "unlocked" }),
      reset: () => {
        [...prompts.keys()].forEach((id) => dismiss(id));
        incoming.clear();
        forgetOutgoing();
        send({ type: "reset" });
      },
      onEvent: (type, event) => {
        if (stopped) return;
        if (type === "E2EE_LINK_RESPONSE" && event.stage === "cancel") {
          incoming.delete(event.request_id);
          if (prompts.has(event.request_id)) dismiss(event.request_id);
          if (remotePrompts.delete(event.request_id)) hooks.onDismiss(event.request_id);
          return;
        }
        if (!leader) return;
        (type === "E2EE_LINK_REQUEST" ? onRequest(event) : onResponse(event)).catch((error) =>
          console.error("[e2ee] link", error),
        );
      },
      outgoing: () => (leader ? snapshot() : remote),
    };
  };

  // client/e2ee/src/channelLoader.ts
  function createChannelLoader({ current, load, receive, retry, retryMs = 5000 }) {
    const pending = new Map();
    let failed = null;
    let timer = null;
    return (channelId) => {
      if (pending.has(channelId) || (failed?.channelId === channelId && Date.now() < failed.after))
        return;
      const task = Promise.resolve()
        .then(() => load(channelId))
        .then((value) => {
          if (current() !== channelId) return;
          failed = null;
          receive(channelId, value);
        })
        .catch(() => {
          if (current() !== channelId) return;
          failed = { channelId, after: Date.now() + retryMs };
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            if (current() === channelId) retry();
          }, retryMs);
        })
        .finally(() => pending.delete(channelId));
      pending.set(channelId, task);
    };
  }

  // client/e2ee/src/ui.ts
  var LOCK_PATH =
    "M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z";
  var OPEN_LOCK_PATH =
    "M9 10h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 9.58-2 1 1 0 1 1-1.83.8A3 3 0 0 0 9 7v3Z";
  var VERIFIED_PATH = `${LOCK_PATH}M8.1 15.6l1.4-1.4 1.9 1.9 4.5-4.5 1.4 1.4-5.9 5.9Z`;
  var CLOSE_PATH =
    "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";
  var SCREEN_PATH =
    "M4 3a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h7v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h7a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H4Zm0 2h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z";
  var css = `
.fe2ee-safety-option{display:flex;align-items:center;gap:8px;min-height:40px;cursor:pointer}
.fe2ee-safety-option input{width:18px;height:18px;accent-color:var(--button-filled-brand-background,var(--focus-primary))}
.fe2ee-lock{display:inline-flex;vertical-align:-2px;margin-inline-start:4px;color:var(--text-muted,#949ba4)}
.fe2ee-lock svg{width:14px;height:14px}
.fe2ee-lock[data-state="failed"]{color:var(--status-danger,#f23f43)}
.fe2ee-toggle{background:none;border:0;padding:0;margin:0 8px;width:24px;height:24px;flex:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--interactive-icon-default,var(--interactive-normal,#b5bac1));transition:color 120ms ease-out,scale 200ms ease-out}
.fe2ee-toggle svg{width:24px;height:24px}
.fe2ee-toggle[aria-pressed="true"]{color:var(--text-muted,#949ba4)}
.fe2ee-toggle:active{scale:.94}
.fe2ee-toggle:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px;border-radius:4px}
@media (hover:hover){.fe2ee-toggle:hover{color:var(--interactive-icon-hover,var(--interactive-hover,#dbdee1))}.fe2ee-toggle[aria-pressed="true"]:hover{color:var(--text-muted,#949ba4)}}
.fe2ee-tooltip{position:fixed;z-index:10002;pointer-events:none;max-width:220px;padding:8px 12px;border-radius:8px;font-size:14px;line-height:18px;font-weight:500;text-align:center;text-wrap:balance;color:var(--text-strong,#f2f3f5);background:var(--background-surface-highest,#111214);box-shadow:0 0 0 1px var(--border-subtle,rgb(255 255 255 / .06)),0 2px 4px rgb(0 0 0 / .16),0 8px 16px rgb(0 0 0 / .24)}
.fe2ee-tooltip::before{content:"";position:absolute;left:calc(50% - 5px);width:10px;height:10px;rotate:45deg;background:inherit}
.fe2ee-tooltip[data-side="bottom"]::before{top:-4px}
.fe2ee-tooltip[data-side="top"]::before{bottom:-4px}
.fe2ee-notice{display:flex;align-items:center;gap:12px;margin:0 0 8px;padding:8px 8px 8px 12px;min-height:40px;box-sizing:border-box;border-radius:8px;font-size:14px;line-height:18px;color:var(--text-default,#dbdee1);background:var(--background-base-lower,#2b2d31);box-shadow:inset 0 0 0 1px var(--border-subtle,rgb(255 255 255 / .06))}
.fe2ee-notice svg{flex:none;width:16px;height:16px;color:var(--icon-default,#b5bac1)}
.fe2ee-notice[data-tone="danger"] svg{color:var(--status-danger,#f23f43)}
.fe2ee-notice[data-tone="warning"] svg{color:var(--status-warning,#f0b232)}
.fe2ee-notice p{margin:0;flex:1;min-width:0;text-wrap:pretty}
.fe2ee-notice .fe2ee-button{padding:4px 12px;min-height:28px}
.fe2ee-button{font:inherit;font-size:14px;font-weight:500;line-height:18px;border:0;border-radius:8px;padding:8px 16px;min-height:38px;cursor:pointer;color:#fff;background:var(--control-primary-background-default,var(--button-filled-brand-background,#5865f2));transition:background-color 120ms ease-out,scale 200ms ease-out;white-space:nowrap}
.fe2ee-button[data-variant="secondary"]{color:var(--text-default,#dbdee1);background:var(--control-secondary-background-default,var(--button-secondary-background,#4e5058))}
.fe2ee-button[data-variant="danger"]{color:#fff;background:var(--control-critical-primary-background-default,#da373c)}
.fe2ee-button[data-variant="link"]{padding:0;min-height:0;background:none;color:var(--text-link,#00a8fc);font-weight:400}
.fe2ee-button:disabled{opacity:.5;cursor:not-allowed}
.fe2ee-button:active:not(:disabled){scale:.97}
.fe2ee-button:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
@media (hover:hover){.fe2ee-button:hover:not(:disabled){background:var(--control-primary-background-hover,#4752c4)}.fe2ee-button[data-variant="secondary"]:hover:not(:disabled){background:var(--control-secondary-background-hover,#6d6f78)}.fe2ee-button[data-variant="danger"]:hover:not(:disabled){background:var(--control-critical-primary-background-hover,#a12829)}.fe2ee-button[data-variant="link"]:hover:not(:disabled){background:none;text-decoration:underline}}
.fe2ee-dialog{border:0;padding:0;border-radius:12px;width:min(480px,calc(100vw - 32px));max-height:min(720px,calc(100dvh - 64px));overflow:hidden;color:var(--text-default,#dbdee1);background:var(--modal-background,var(--background-base-low,#313338));box-shadow:0 0 0 1px var(--border-subtle,rgb(255 255 255 / .06)),0 4px 8px rgb(0 0 0 / .16),0 16px 48px rgb(0 0 0 / .32)}
.fe2ee-dialog[open]{display:flex;flex-direction:column}
.fe2ee-dialog:focus{outline:none}
.fe2ee-dialog::backdrop{background:rgb(0 0 0 / .7)}
.fe2ee-dialog-head{flex:none;display:flex;align-items:flex-start;gap:16px;padding:20px 16px 4px 20px}
.fe2ee-dialog h2{flex:1;margin:0;font-size:20px;line-height:24px;font-weight:600;text-wrap:balance;color:var(--text-strong,#f2f3f5)}
.fe2ee-close{flex:none;width:32px;height:32px;margin:-4px 0 0;padding:0;display:grid;place-items:center;border:0;border-radius:8px;background:none;color:var(--interactive-icon-default,#b5bac1);cursor:pointer;transition:color 120ms ease-out,background-color 120ms ease-out}
.fe2ee-close svg{width:24px;height:24px}
.fe2ee-close[hidden]{display:none}
.fe2ee-close:focus-visible{outline:2px solid var(--focus-primary,#00a8fc)}
@media (hover:hover){.fe2ee-close:hover{color:var(--interactive-icon-hover,#dbdee1);background:var(--background-mod-subtle,rgb(255 255 255 / .06))}}
.fe2ee-dialog-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:8px 20px 20px;display:flex;flex-direction:column;gap:12px;font-size:15px;line-height:22px}
.fe2ee-dialog p,.fe2ee-page p{margin:0;text-wrap:pretty;color:var(--text-muted,#b5bac1)}
.fe2ee-dialog-actions{flex:none;display:flex;justify-content:flex-end;gap:8px;padding:16px 20px;background:var(--modal-footer-background,var(--background-base-lower,#2b2d31));box-shadow:0 -1px 0 var(--border-subtle,rgb(255 255 255 / .06))}
@media (prefers-reduced-motion:no-preference){.fe2ee-dialog[open]{animation:fe2ee-modal-in 260ms cubic-bezier(.2,.9,.3,1.05)}.fe2ee-dialog[open]::backdrop{animation:fe2ee-fade 200ms ease-out}.fe2ee-dialog[data-closing]{animation:fe2ee-modal-out 150ms ease-in forwards}.fe2ee-dialog[data-closing]::backdrop{animation:fe2ee-fade 150ms ease-in reverse forwards}.fe2ee-tooltip{animation:fe2ee-fade 120ms ease-out}}
@keyframes fe2ee-modal-in{from{opacity:0;scale:.9}}
@keyframes fe2ee-modal-out{to{opacity:0;scale:.9}}
@keyframes fe2ee-fade{from{opacity:0}}
.fe2ee-member{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.fe2ee-member + .fe2ee-member{border-top:1px solid var(--border-subtle,rgb(255 255 255 / .06));padding-top:16px}
.fe2ee-member-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.fe2ee-member-name{font-weight:600;color:var(--text-strong,#f2f3f5);overflow-wrap:anywhere}
.fe2ee-status{display:inline-flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap;color:var(--text-muted,#b5bac1)}
.fe2ee-status[data-verified="true"]{color:var(--status-positive,#23a55a)}
.fe2ee-status[data-changed="true"]{color:var(--text-feedback-warning,var(--status-warning,#f0b232))}
.fe2ee-status svg{width:14px;height:14px}
.fe2ee-safety{display:flex;gap:16px;align-items:center}
.fe2ee-digits{flex:1;display:grid;grid-template-columns:repeat(4,auto);justify-content:start;gap:4px 16px;font-size:17px;line-height:24px;font-variant-numeric:tabular-nums;letter-spacing:.04em;color:var(--text-strong,#f2f3f5)}
.fe2ee-member-actions{display:flex;gap:8px;flex-wrap:wrap}
[data-fe2ee-state="pending"],[data-fe2ee-state="locked"],[data-fe2ee-state="missing"],[data-fe2ee-state="reset"],[data-fe2ee-state="failed"]{color:var(--text-muted,#949ba4);font-style:italic}
[id^="message-content-"] > [class*="timestamp_"]:has(> .fe2ee-lock){white-space:nowrap}
.fe2ee-codes{display:flex;flex-direction:column;gap:4px}
.fe2ee-codes[hidden]{display:none}
.fe2ee-code-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px}
.fe2ee-code-name{min-width:0;font-size:14px;line-height:18px;color:var(--text-muted,#b5bac1);overflow-wrap:anywhere}
.fe2ee-unlock{font:inherit;font-style:normal;font-size:13px;font-weight:500;line-height:18px;margin-inline-start:8px;padding:2px 8px;border:0;border-radius:4px;cursor:pointer;color:var(--text-default,#dbdee1);background:var(--control-secondary-background-default,#4e5058);transition:background-color 120ms ease-out,scale 200ms ease-out}
.fe2ee-unlock:active{scale:.97}
.fe2ee-unlock:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}
@media (hover:hover){.fe2ee-unlock:hover{background:var(--control-secondary-background-hover,#6d6f78)}}
.fe2ee-section{display:flex;flex-direction:column;gap:8px;padding-top:16px;border-top:1px solid var(--border-subtle,rgb(255 255 255 / .06))}
.fe2ee-section[hidden]{display:none}
.fe2ee-section h3{margin:0;font-size:16px;line-height:20px;font-weight:600;color:var(--text-strong,#f2f3f5)}
.fe2ee-section > .fe2ee-button{align-self:flex-start}
.fe2ee-field{display:flex;flex-direction:column;gap:8px}
.fe2ee-field label{font-size:14px;font-weight:500;color:var(--text-default,#dbdee1)}
.fe2ee-row{display:flex;gap:8px;align-items:center}
.fe2ee-input{flex:1;min-width:0;font:inherit;font-size:16px;line-height:20px;padding:9px 12px;border-radius:8px;border:0;color:var(--text-default,#dbdee1);background:var(--input-background-default,var(--background-base-lowest,#1e1f22));box-shadow:inset 0 0 0 1px var(--border-subtle,rgb(255 255 255 / .06))}
.fe2ee-input-code{font-family:var(--font-code,ui-monospace,monospace);font-size:15px;letter-spacing:.02em;text-transform:uppercase}
.fe2ee-input-code::placeholder{text-transform:none}
.fe2ee-row[data-stack]{flex-direction:column;align-items:stretch}
.fe2ee-row[data-stack] > .fe2ee-input{flex:none;width:100%;box-sizing:border-box}
.fe2ee-row[data-stack] > .fe2ee-button{align-self:flex-start}
.fe2ee-input:focus-visible{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:-1px}
.fe2ee-input[aria-invalid="true"]{box-shadow:inset 0 0 0 1px var(--status-danger,#f23f43)}
.fe2ee-input[aria-invalid="true"]:focus-visible{outline-color:var(--status-danger,#f23f43)}
.fe2ee-field:has(.fe2ee-input[aria-invalid="true"]) label{color:var(--text-feedback-critical,var(--status-danger,#f23f43))}
.fe2ee-dialog p.fe2ee-detail{margin-top:-8px;font-size:14px;line-height:18px}
.fe2ee-dialog .fe2ee-error,.fe2ee-page .fe2ee-error{margin:0;font-size:14px;line-height:18px;color:var(--text-feedback-critical,var(--status-danger,#f23f43))}
.fe2ee-code{font-size:28px;line-height:36px;font-weight:600;letter-spacing:.08em;font-variant-numeric:tabular-nums;color:var(--text-strong,#f2f3f5)}
.fe2ee-recovery{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:0;padding:12px;list-style:none;border-radius:8px;background:var(--background-base-lowest,#1e1f22)}
.fe2ee-recovery li{font-family:var(--font-code,ui-monospace,monospace);font-size:16px;line-height:24px;font-weight:600;text-align:center;letter-spacing:.06em;color:var(--text-strong,#f2f3f5)}
.fe2ee-devices{display:flex;flex-direction:column;border-radius:8px;background:var(--card-background-default,var(--background-base-lower,#2b2d31));box-shadow:inset 0 0 0 1px var(--border-subtle,rgb(255 255 255 / .06))}
.fe2ee-device{display:flex;align-items:center;gap:12px;padding:12px 16px}
.fe2ee-device + .fe2ee-device{border-top:1px solid var(--border-subtle,rgb(255 255 255 / .06))}
.fe2ee-device-icon{flex:none;width:40px;height:40px;display:grid;place-items:center;border-radius:50%;color:var(--icon-default,#b5bac1);background:var(--background-mod-subtle,rgb(255 255 255 / .06))}
.fe2ee-device-icon svg{width:20px;height:20px}
.fe2ee-device-text{flex:1;min-width:0;display:flex;flex-direction:column}
.fe2ee-device-name{font-size:15px;line-height:20px;font-weight:600;color:var(--text-strong,#f2f3f5);overflow-wrap:anywhere}
.fe2ee-device-meta{font-size:13px;line-height:18px;color:var(--text-muted,#b5bac1);overflow-wrap:anywhere}
.fe2ee-device-meta[data-current="true"]{color:var(--text-feedback-positive,var(--status-positive,#23a55a))}
.fe2ee-device-actions{flex:none;display:flex;gap:8px}
.fe2ee-page{display:flex;flex-direction:column;gap:40px;font-size:14px;line-height:20px;color:var(--text-default,#dbdee1);padding-bottom:40px}
.fe2ee-page .fe2ee-section{border-top:0;padding-top:0;gap:12px}
.fe2ee-page .fe2ee-section + .fe2ee-section{border-top:1px solid var(--border-subtle,rgb(255 255 255 / .06));padding-top:40px}
.fe2ee-page .fe2ee-section h3{font-size:24px;line-height:30px;font-weight:400;margin-bottom:4px}
`;
  var svg = (path, label) =>
    `<svg viewBox="0 0 24 24" fill="currentColor" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}><path fill-rule="evenodd" d="${path}"/></svg>`;
  var escape = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  var currentChannel = () => /^\/channels\/@me\/(\d+)/.exec(location.pathname)?.[1] ?? null;
  var memberName = (m) => m.global_name || m.username;
  var reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  var ago = (iso) => {
    const seconds = (Date.parse(iso) - Date.now()) / 1000;
    const steps = [
      [60, "second"],
      [60, "minute"],
      [24, "hour"],
      [30, "day"],
      [12, "month"],
      [Infinity, "year"],
    ];
    let value = seconds;
    for (const [size, unit] of steps) {
      if (Math.abs(value) < size)
        return new Intl.RelativeTimeFormat(locale(), { numeric: "auto" }).format(
          Math.round(value),
          unit,
        );
      value /= size;
    }
    return "";
  };
  var UNLOCK_SNOOZE_KEY = "fe2ee-unlock-snoozed-until";
  var UNLOCK_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
  var INVITE_MS = 15000;
  var unlockSnoozed = () => {
    try {
      return Number(browserStorage?.getItem(UNLOCK_SNOOZE_KEY)) > Date.now();
    } catch {
      return false;
    }
  };
  var snoozeUnlock = () => {
    try {
      browserStorage?.setItem(UNLOCK_SNOOZE_KEY, String(Date.now() + UNLOCK_SNOOZE_MS));
    } catch {
      return;
    }
  };
  var createUi = ({ engine, ready, states, enableChannel, link, verifyPassword, reset }) => {
    const style = document.createElement("style");
    style.textContent = css;
    const bar = document.createElement("div");
    bar.className = "fe2ee-notice";
    bar.setAttribute("role", "status");
    let bootstrapped = false;
    ready.then((ok) => {
      bootstrapped = ok;
      refresh();
    });
    let failure = null;
    let paused = null;
    let transient = null;
    let transientTimer = null;
    let unlockOpen = null;
    const approvals = new Map();
    let members = null;
    const loadMembers = createChannelLoader({
      current: currentChannel,
      load: (id) =>
        engine
          .channelMembers(id)
          .then((ids) => Promise.all(ids.map((member) => engine.profile(member)))),
      receive: (channelId, list) => {
        members = { channelId, list };
        refresh();
      },
      retry: () => refresh(),
    });
    let scheduled = false;
    let tooltip = null;
    let backupPromptDismissed = false;
    let requiredPasswordOpen = null;
    let passwordPromptTimer = null;
    const invited = new Map();
    const mount = () => {
      if (!style.isConnected) document.head.append(style);
    };
    const flash = (channelId, notice, ms = 8000) => {
      transient = { ...notice, channelId, until: Date.now() + ms };
      if (transientTimer) clearTimeout(transientTimer);
      transientTimer = setTimeout(refresh, ms + 50);
      refresh();
    };
    const hideTooltip = () => {
      tooltip?.remove();
      tooltip = null;
    };
    const showTooltip = (anchor, text) => {
      hideTooltip();
      const el = document.createElement("div");
      el.className = "fe2ee-tooltip";
      el.setAttribute("role", "tooltip");
      el.textContent = text;
      document.body.append(el);
      const box = anchor.getBoundingClientRect();
      const below = box.bottom + 8 + el.offsetHeight < innerHeight;
      el.dataset.side = below ? "bottom" : "top";
      el.style.top = `${below ? box.bottom + 8 : box.top - 8 - el.offsetHeight}px`;
      el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, box.left + box.width / 2 - el.offsetWidth / 2))}px`;
      tooltip = el;
    };
    const withTooltip = (el, text) => {
      const show = () => showTooltip(el, text());
      el.addEventListener("mouseenter", show);
      el.addEventListener("focus", show);
      el.addEventListener("mouseleave", hideTooltip);
      el.addEventListener("blur", hideTooltip);
      el.addEventListener("click", hideTooltip);
    };
    const button = (label, variant, run) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "fe2ee-button";
      el.dataset.variant = variant;
      el.textContent = label;
      el.addEventListener("click", run);
      return el;
    };
    addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          document.querySelector("dialog.fe2ee-dialog[open]:not([data-closing])")
        )
          event.stopPropagation();
      },
      true,
    );
    const dialog = (title, build) => {
      const el = document.createElement("dialog");
      el.className = "fe2ee-dialog";
      el.setAttribute("aria-label", title);
      const head = document.createElement("div");
      head.className = "fe2ee-dialog-head";
      head.innerHTML = `<h2>${escape(title)}</h2>`;
      const x = document.createElement("button");
      x.type = "button";
      x.className = "fe2ee-close";
      x.setAttribute("aria-label", t("Close"));
      x.innerHTML = svg(CLOSE_PATH);
      head.append(x);
      const body = document.createElement("div");
      body.className = "fe2ee-dialog-body";
      const actions = document.createElement("div");
      actions.className = "fe2ee-dialog-actions";
      el.append(head, body, actions);
      let dismissable = true;
      let closing = false;
      const close = () => {
        if (closing || !el.isConnected) return;
        closing = true;
        const finish = () => {
          el.close();
          el.remove();
        };
        if (reducedMotion()) return finish();
        el.dataset.closing = "";
        el.addEventListener("animationend", finish, { once: true });
        setTimeout(finish, 250);
      };
      const handle = {
        el,
        close,
        setDismissable: (value) => {
          dismissable = value;
          x.hidden = !value;
        },
      };
      x.addEventListener("click", close);
      el.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (dismissable) close();
      });
      let pressedBackdrop = false;
      el.addEventListener("pointerdown", (event) => {
        pressedBackdrop = event.target === el;
      });
      el.addEventListener("click", (event) => {
        if (event.target === el && pressedBackdrop && dismissable) close();
        pressedBackdrop = false;
      });
      const initial =
        build(body, actions, handle) ??
        body.querySelector("input") ??
        actions.querySelector('.fe2ee-button[data-variant="primary"]') ??
        el;
      if (initial === el) el.tabIndex = -1;
      initial.autofocus = true;
      document.body.append(el);
      el.showModal();
      initial.focus({ focusVisible: initial instanceof HTMLInputElement });
      return handle;
    };
    const field = (labelText, type, autocomplete) => {
      const id = `fe2ee-${Math.random().toString(36).slice(2)}`;
      const wrap = document.createElement("div");
      wrap.className = "fe2ee-field";
      wrap.innerHTML = `<label for="${id}">${escape(labelText)}</label><div class="fe2ee-row"></div><p class="fe2ee-error" id="${id}-error" role="alert" hidden></p>`;
      const input = document.createElement("input");
      input.className = "fe2ee-input";
      input.id = id;
      input.type = type;
      input.autocomplete = autocomplete;
      input.spellcheck = false;
      input.setAttribute("aria-describedby", `${id}-error`);
      const row = wrap.querySelector(".fe2ee-row");
      row.append(input);
      const error = wrap.querySelector(".fe2ee-error");
      const setError = (text) => {
        error.hidden = !text;
        error.textContent = text ?? "";
        input.setAttribute("aria-invalid", String(!!text));
        if (text) input.focus();
      };
      return { wrap, input, row, setError };
    };
    const section = (title, text) => {
      const el = document.createElement("section");
      el.className = "fe2ee-section";
      el.innerHTML = `<h3>${escape(title)}</h3>${text ? `<p>${escape(text)}</p>` : ""}`;
      return el;
    };
    const describe = (el, text) => {
      const p = document.createElement("p");
      p.textContent = text;
      el.append(p);
      return p;
    };
    const namesOf = async (ids) => {
      const list = await Promise.all(ids.map((id) => engine.profile(id)));
      const names = list.map(memberName);
      if (names.length <= 1) return names[0] ?? t("Someone here");
      return conjunction(names);
    };
    const showError = (error, channelId) => {
      const name = (id) =>
        id && members?.channelId === channelId
          ? (members.list.find((m) => m.id === id) ?? null)
          : null;
      const body = error?.body;
      if (body?.message === "E2EE_RECIPIENT_NO_DEVICES") {
        const ids = Array.isArray(body.user_ids) ? body.user_ids.map(String) : [];
        namesOf(ids).then((who) =>
          flash(channelId, {
            tone: "warning",
            text:
              ids.length > 1
                ? t(
                    "{names} haven't set up encryption yet. Ask them to open the app once, then try again.",
                    { names: who },
                  )
                : t(
                    "{name} hasn't set up encryption yet. Ask them to open the app once, then try again.",
                    { name: who },
                  ),
          }),
        );
        return;
      }
      let text = t("Your message couldn't be encrypted, so it wasn't sent.");
      let action;
      if (error instanceof E2eeError) {
        const who = name(error.userId);
        if (error.code === "NO_DEVICES")
          text = t(
            "{name} hasn't set up encryption yet, so your message wasn't sent. Ask them to open the app once.",
            { name: who ? memberName(who) : t("Someone here") },
          );
        else if (error.code === "IDENTITY_CHANGED")
          text = t("{name}'s safety number changed. Review it before sending more messages.", {
            name: who ? memberName(who) : t("Someone"),
          });
        else if (error.code === "UNSUPPORTED")
          text = t("{reason}. Your message wasn't sent.", { reason: error.message });
        else if (error.code === "NOT_LINKED") {
          text = engine.trustsServer
            ? t("Preparing private chat… Your message is still in the text box.")
            : t("Unlock this browser to send encrypted messages. Your message wasn't sent.");
          if (!engine.trustsServer) action = { label: t("Unlock"), run: showUnlock };
        } else if (error.code === "NOT_READY")
          text = t("End-to-end encryption is unavailable right now, so your message wasn't sent.");
      }
      flash(channelId, { tone: "danger", text, action });
    };
    const confirmEnable = (channelId) =>
      dialog(t("Turn on end-to-end encryption?"), (body, actions, { close }) => {
        body.insertAdjacentHTML(
          "beforeend",
          `<p>${escape(t("New messages, files and stickers in this conversation are encrypted in your browser before they're sent, and only the people in it can read them. Encryption can't be turned off later."))}</p><p>${escape(t("Polls can't be sent in encrypted conversations."))}</p>`,
        );
        const error = document.createElement("p");
        error.className = "fe2ee-error";
        error.setAttribute("role", "alert");
        error.hidden = true;
        body.append(error);
        const notReady = (ids) =>
          namesOf(ids).then((who) => {
            error.textContent =
              ids.length > 1
                ? t(
                    "{names} haven't set up encryption yet, so this conversation can't be encrypted. Ask them to open the app once, then try again.",
                    { names: who },
                  )
                : t(
                    "{name} hasn't set up encryption yet, so this conversation can't be encrypted. Ask them to open the app once, then try again.",
                    { name: who },
                  );
            error.hidden = false;
            confirm.disabled = true;
          });
        const confirm = button(t("Turn on encryption"), "primary", async () => {
          confirm.disabled = true;
          error.hidden = true;
          try {
            await enableChannel(channelId);
            close();
          } catch (failure) {
            const body = failure?.body;
            if (body?.message === "E2EE_RECIPIENT_NO_DEVICES")
              return void (await notReady(
                Array.isArray(body.user_ids) ? body.user_ids.map(String) : [],
              ));
            error.textContent = t("Couldn't turn on encryption. {error}", {
              error: errorText(failure),
            });
            error.hidden = false;
            confirm.disabled = false;
          }
        });
        actions.append(button(t("Cancel"), "secondary", close), confirm);
        engine
          .channelMembers(channelId)
          .then((ids) => engine.keysFor(ids, true))
          .then((entries) => {
            const missing = entries
              .filter((entry) => !entry.devices.some((d) => d.status === "active"))
              .map((entry) => entry.userId);
            if (missing.length) return notReady(missing);
          })
          .catch(() => {});
      });
    const showSafety = async (channelId) => {
      const list = await Promise.all(
        (await engine.channelMembers(channelId)).map((id) => engine.profile(id)),
      );
      dialog(t("Safety numbers"), (body, actions, { close }) => {
        body.insertAdjacentHTML(
          "beforeend",
          `<p>${escape(t("Compare these numbers with each person in a call or face to face. If they match, nobody is intercepting your messages. Mark them as verified so you're warned if they change."))}</p>`,
        );
        for (const member of list) {
          const block = document.createElement("section");
          block.className = "fe2ee-member";
          block.innerHTML = `<div class="fe2ee-member-head"><span class="fe2ee-member-name">${escape(memberName(member))}</span><span class="fe2ee-status"></span></div><div class="fe2ee-safety"><div class="fe2ee-digits" aria-label="${escape(t("Safety number for {name}", { name: memberName(member) }))}">${escape(t("Calculating…"))}</div></div><div class="fe2ee-member-actions"></div>`;
          body.append(block);
          const render = async () => {
            const contact = engine.contacts[member.id];
            const status = block.querySelector(".fe2ee-status");
            status.dataset.verified = String(!!contact?.verified && !contact.pendingKey);
            status.dataset.changed = String(!!contact?.pendingKey);
            status.innerHTML = contact?.pendingKey
              ? `${svg(OPEN_LOCK_PATH)}${escape(t("Safety number changed"))}`
              : contact?.verified
                ? `${svg(VERIFIED_PATH)}${escape(t("Verified"))}`
                : `${svg(OPEN_LOCK_PATH)}${escape(t("Not verified"))}`;
            const digits = await engine.safetyNumber(member.id);
            const grid = block.querySelector(".fe2ee-digits");
            grid.innerHTML = digits
              ? (digits.match(/\d{5}/g) ?? []).map((g) => `<span>${g}</span>`).join("")
              : escape(t("This person hasn't set up encryption yet."));
            grid.dataset.number = digits ?? "";
            const row = block.querySelector(".fe2ee-member-actions");
            row.replaceChildren();
            if (!contact) return;
            if (contact.pendingKey)
              row.append(
                button(t("Accept new safety number"), "primary", async () => {
                  await engine.acceptIdentity(member.id);
                  render();
                }),
              );
            else
              row.append(
                button(
                  contact.verified ? t("Remove verification") : t("Mark as verified"),
                  contact.verified ? "secondary" : "primary",
                  async () => {
                    await engine.setVerified(member.id, !contact.verified);
                    render();
                  },
                ),
              );
          };
          render();
        }
        actions.append(
          button(t("Encryption settings"), "secondary", () => {
            close();
            showSettings();
          }),
          button(t("Done"), "primary", close),
        );
      });
    };
    const showReset = (onDone) =>
      dialog(t("Reset encryption?"), (body, actions, { close }) => {
        describe(
          body,
          engine.linked
            ? t(
                "This replaces your encryption keys. Only do this if you think someone else got hold of them.",
              )
            : engine.backup?.mode === "recovery"
              ? t(
                  "Only do this if you lost your recovery code and no other signed-in browser can approve this one.",
                )
              : t(
                  "Only do this if your password doesn't unlock your keys and no other signed-in browser can approve this one.",
                ),
        );
        describe(
          body,
          t(
            "You get new keys and can keep chatting, but none of your browsers can read the messages sent before the reset anymore. The people you talk to keep what they received.",
          ),
        );
        describe(
          body,
          t(
            "Your other browsers have to be approved again, and the people you talk to are told that your safety number changed.",
          ),
        );
        const { wrap, input, setError } = field(
          t("Account password"),
          "password",
          "current-password",
        );
        body.append(wrap);
        const confirm = button(t("Reset encryption"), "danger", async () => {
          if (!input.value) return setError(t("Enter your password."));
          confirm.disabled = true;
          setError(null);
          try {
            await reset(input.value);
            close();
            onDone?.();
            const channelId = currentChannel();
            if (channelId)
              flash(
                channelId,
                { tone: "info", text: t("Encryption was reset. New messages use your new keys.") },
                6000,
              );
          } catch (error) {
            const status = error?.status;
            setError(status === 400 ? t("That password isn't right.") : errorText(error));
          } finally {
            confirm.disabled = false;
          }
        });
        input.addEventListener("keydown", (event) => event.key === "Enter" && confirm.click());
        actions.append(button(t("Cancel"), "secondary", close), confirm);
        requestAnimationFrame(() => input.focus());
      });
    const unlockForm = (kind) => {
      const { wrap, input, row, setError } =
        kind === "password"
          ? field(t("Account password"), "password", "current-password")
          : field(t("Recovery code"), "text", "off");
      if (kind === "recovery") {
        input.placeholder = "XXXX XXXX XXXX XXXX XXXX XXXX XXXX XXXX";
        input.classList.add("fe2ee-input-code");
        row.dataset.stack = "";
      }
      const submit = button(t("Unlock"), "primary", async () => {
        if (!input.value.trim())
          return setError(
            kind === "password" ? t("Enter your password.") : t("Enter your recovery code."),
          );
        submit.disabled = true;
        setError(null);
        try {
          await engine.unlockWith(kind, input.value.trim());
        } catch (error) {
          setError(errorText(error));
        } finally {
          submit.disabled = false;
        }
      });
      input.addEventListener("keydown", (event) => event.key === "Enter" && submit.click());
      row.append(submit);
      return wrap;
    };
    const showRequiredPassword = () => {
      if (requiredPasswordOpen || unlockOpen || !engine.locked || !engine.trustsServer || failure)
        return;
      dialog(t("Enter your password"), (body, actions, { el, close, setDismissable }) => {
        setDismissable(false);
        el.dataset.requiredPassword = "true";
        describe(body, t("Enter your account password to finish setting up this browser."));
        const { wrap, input, setError } = field(
          t("Account password"),
          "password",
          "current-password",
        );
        input.required = true;
        body.append(wrap);
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          stop();
          requiredPasswordOpen = null;
          if (engine.linked && transient?.tone === "info") transient = null;
          close();
          refresh();
        };
        const stop = engine.onChange(() => {
          if (engine.linked) finish();
        });
        requiredPasswordOpen = finish;
        const advanced = button(t("Advanced recovery"), "link", showSettings);
        advanced.hidden = true;
        const submit = button(t("Continue"), "primary", async () => {
          if (!input.value) return setError(t("Enter your password."));
          submit.disabled = true;
          setError(null);
          try {
            if (!(await verifyPassword(input.value)))
              return setError(t("That password isn't right."));
            await engine.reloadBackup();
            if (engine.backup?.mode === "password" && engine.backup.wrapped_secret)
              await engine.unlockWith("password", input.value).catch(() => {});
            if (!engine.linked) await engine.recoverWithPassword(input.value).catch(() => false);
            if (!engine.linked) {
              await link.request();
              await new Promise((resolve) => {
                const timer = setTimeout(() => {
                  unsubscribe();
                  resolve();
                }, 8000);
                const unsubscribe = engine.onChange(() => {
                  if (!engine.linked) return;
                  clearTimeout(timer);
                  unsubscribe();
                  resolve();
                });
              });
            }
            input.value = "";
            if (engine.linked) finish();
            else {
              advanced.hidden = false;
              setError(
                t(
                  "Your saved keys aren’t available yet. Open a browser where your messages still work, or use your recovery code in Encryption settings.",
                ),
              );
            }
          } catch (error) {
            setError(errorText(error));
          } finally {
            submit.disabled = false;
          }
        });
        input.addEventListener("keydown", (event) => event.key === "Enter" && submit.click());
        actions.append(advanced, submit);
      });
    };
    const showUnlock = () => {
      if (unlockOpen || !engine.locked) return;
      const current = link.outgoing();
      if (!current || current.state === "failed") link.request().catch(() => {});
      dialog(t("Unlock encrypted messages"), (body, actions, { el, close }) => {
        const backup = engine.backup;
        const intro = describe(
          body,
          t(
            "This browser can't read your encrypted messages yet. Bring your keys over with one of these.",
          ),
        );
        if (!backup || (backup.mode === "password" && !backup.wrapped_secret)) {
          const own = section(
            t("Enter your password"),
            t(
              "If your keys aren't backed up with your password yet, open the app on a browser you used before. It asks for your password once, and then it works here too.",
            ),
          );
          own.append(unlockForm("password"));
          body.append(own);
        } else if (backup.wrapped_secret && backup.identity_key === engine.serverKey) {
          const own = section(
            backup.mode === "recovery" ? t("Enter your recovery code") : t("Enter your password"),
            backup.mode === "recovery"
              ? t("Use the code you saved when you switched to a recovery code.")
              : undefined,
          );
          own.append(unlockForm(backup.mode));
          body.append(own);
        }
        const approval = section(t("Approve from another device"));
        const status = document.createElement("p");
        status.setAttribute("role", "status");
        const codes = document.createElement("div");
        codes.className = "fe2ee-codes";
        const again = button(t("Ask for approval"), "secondary", () =>
          link.request().catch(() => {}),
        );
        approval.append(status, codes, again);
        body.append(approval);
        const lost = section(
          backup?.mode === "recovery" ? t("Lost your code?") : t("Can't unlock this browser?"),
        );
        describe(
          lost,
          t(
            "If you can't use any of these, reset encryption to keep chatting. Messages sent before the reset can't be read anymore.",
          ),
        );
        lost.append(button(t("Reset encryption"), "link", () => showReset(done)));
        body.append(lost);
        const render = () => {
          const state = link.outgoing();
          const approvers = state?.state === "comparing" ? state.approvers : [];
          codes.hidden = !approvers.length;
          codes.replaceChildren(
            ...approvers.map(({ name, sas }) => {
              const row = document.createElement("div");
              row.className = "fe2ee-code-row";
              row.innerHTML = `${approvers.length > 1 ? `<span class="fe2ee-code-name">${escape(name)}</span>` : ""}<span class="fe2ee-code">${escape(sas)}</span>`;
              return row;
            }),
          );
          again.hidden =
            state?.state === "waiting" ||
            state?.state === "comparing" ||
            state?.state === "done" ||
            state?.state === "denied";
          again.textContent = state ? t("Ask again") : t("Ask for approval");
          status.textContent =
            state?.state === "comparing"
              ? approvers.length > 1
                ? t(
                    "Your signed-in browsers are asking you to approve this one. Approve it on any of them after checking that it shows the code listed under its name.",
                  )
                : t(
                    "{name} is asking you to approve this browser. Check that it shows this code, then approve it there.",
                    {
                      name: approvers[0]?.name ?? t("Your other browser"),
                    },
                  )
              : state?.state === "denied"
                ? t("This login was denied on your other browser, so this browser was signed out.")
                : state?.state === "failed"
                  ? state.error
                    ? t("The approval didn't unlock this browser. {error}", { error: state.error })
                    : t("The approval didn't unlock this browser. Ask again to retry.")
                  : state?.state === "waiting"
                    ? t(
                        "Open the app on a browser where you're already signed in. It asks you to approve this one.",
                      )
                    : t("Ask a browser where you're already signed in to approve this one.");
          const denied = state?.state === "denied";
          for (const el of [intro, ...body.querySelectorAll(":scope > .fe2ee-section")])
            el.hidden = denied && el !== approval;
          notNow.textContent = denied ? t("Close") : t("Not now");
          if (engine.linked) {
            done();
            const channelId = currentChannel();
            if (channelId)
              flash(channelId, { tone: "info", text: t("This browser is unlocked.") }, 4000);
          }
        };
        const stop = engine.onChange(render);
        const done = () => {
          stop();
          unlockOpen = null;
          close();
        };
        unlockOpen = { render, close: done };
        el.addEventListener("close", () => {
          stop();
          unlockOpen = null;
          if (engine.locked && link.outgoing()?.state !== "denied") snoozeUnlock();
        });
        const notNow = button(t("Not now"), "secondary", () => {
          link.cancel().catch(() => {});
          done();
        });
        actions.append(notNow);
        render();
      });
    };
    const showApproval = (prompt) => {
      if (approvals.has(prompt.requestId)) return;
      dialog(t("New login on {name}", { name: prompt.name }), (body, actions, { el, close }) => {
        body.insertAdjacentHTML(
          "beforeend",
          `${prompt.detail ? `<p class="fe2ee-detail">${escape(prompt.detail)}</p>` : ""}<p>${escape(t("Approve it only if you just signed in there yourself, because it gets access to your encrypted messages. Deny signs it out. The other browser should show this code:"))}</p><div class="fe2ee-code">${escape(prompt.sas)}</div>`,
        );
        const error = document.createElement("p");
        error.className = "fe2ee-error";
        error.setAttribute("role", "alert");
        error.hidden = true;
        body.append(error);
        const finish = () => {
          approvals.delete(prompt.requestId);
          close();
        };
        approvals.set(prompt.requestId, finish);
        el.addEventListener("close", () => approvals.delete(prompt.requestId));
        const run = async (action) => {
          approve.disabled = deny.disabled = true;
          error.hidden = true;
          try {
            await action();
            finish();
          } catch (failure) {
            error.textContent = t("Couldn't answer that login. {error}", {
              error: errorText(failure),
            });
            error.hidden = false;
            approve.disabled = deny.disabled = false;
          }
        };
        const approve = button(t("Approve login"), "primary", () => run(prompt.approve));
        const deny = button(t("Deny"), "secondary", () => run(prompt.deny));
        actions.append(deny, approve);
        return el;
      });
    };
    const dismissApproval = (requestId) => approvals.get(requestId)?.();
    const backupPasswordForm = (onDone) => {
      const { wrap, input, row, setError } = field(
        t("Account password"),
        "password",
        "current-password",
      );
      const save = button(t("Back up keys"), "primary", async () => {
        if (!input.value) return setError(t("Enter your password."));
        save.disabled = true;
        setError(null);
        try {
          if (!(await verifyPassword(input.value)))
            return setError(t("That password isn't right."));
          await engine.backUpWithPassword(input.value);
          onDone();
        } catch (error) {
          setError(errorText(error));
        } finally {
          save.disabled = false;
        }
      });
      input.addEventListener("keydown", (event) => event.key === "Enter" && save.click());
      row.append(save);
      return wrap;
    };
    const showBackupPassword = () =>
      dialog(t("Back up your encryption keys"), (body, actions, { close }) => {
        describe(
          body,
          t(
            "Your encryption keys only exist in this browser right now. Enter your account password to lock a backup of them with it, so any browser you sign in to can read your encrypted messages.",
          ),
        );
        body.append(
          backupPasswordForm(() => {
            close();
            const channelId = currentChannel();
            if (channelId)
              flash(
                channelId,
                { tone: "info", text: t("Your encryption keys are backed up.") },
                5000,
              );
          }),
        );
        actions.append(button(t("Not now"), "secondary", close));
      });
    const showRecoveryCode = () =>
      dialog(t("Use a recovery code"), (body, actions, { close, setDismissable }) => {
        const intro = describe(
          body,
          t(
            "We'll make a code that locks your key backup instead of your password. You'll need it to set up a new browser when no other device is around to approve it. We only show it once.",
          ),
        );
        const code = generateRecoveryCode();
        const create = button(t("Make recovery code"), "primary", () => {
          setDismissable(false);
          intro.textContent = t(
            "Save this code somewhere safe, like a password manager. Anyone with it and access to your account can read your encrypted messages. It replaces your password lock once you confirm.",
          );
          const grid = document.createElement("ol");
          grid.className = "fe2ee-recovery";
          grid.dataset.code = code;
          grid.setAttribute("aria-label", t("Recovery code"));
          grid.innerHTML = code
            .split("-")
            .map((group) => `<li>${escape(group)}</li>`)
            .join("");
          const error = document.createElement("p");
          error.className = "fe2ee-error";
          error.setAttribute("role", "alert");
          error.hidden = true;
          body.append(grid, error);
          let copiedTimer = null;
          const copy = button(t("Copy code"), "secondary", () => {
            navigator.clipboard
              ?.writeText(code)
              .then(() => {
                copy.textContent = t("Copied!");
                if (copiedTimer) clearTimeout(copiedTimer);
                copiedTimer = setTimeout(() => (copy.textContent = t("Copy code")), 2000);
              })
              .catch(() => {
                copy.textContent = t("Couldn't copy");
              });
          });
          const saved = button(t("I saved it"), "primary", async () => {
            saved.disabled = true;
            error.hidden = true;
            try {
              await engine.setBackupMode("recovery", code);
              close();
            } catch (failure) {
              error.textContent = t("Couldn't switch to the recovery code. {error}", {
                error: errorText(failure),
              });
              error.hidden = false;
              saved.disabled = false;
            }
          });
          actions.replaceChildren(button(t("Cancel"), "secondary", close), copy, saved);
          copy.focus({ focusVisible: false });
        });
        actions.append(button(t("Cancel"), "secondary", close), create);
      });
    const deviceMeta = (device) => {
      const current = device.device_id === engine.device?.deviceId;
      const session = device.session;
      const state = current
        ? t("This browser")
        : device.status === "pending"
          ? t("Waiting for approval")
          : session && !session.signed_in
            ? t("Signed out")
            : session?.last_seen && Date.now() - Date.parse(session.last_seen) < 5 * 60 * 1000
              ? t("Active now")
              : session?.last_seen
                ? t("Last active {time}", { time: ago(session.last_seen) })
                : t("Can read encrypted messages");
      const when = deviceAdded(deviceTwins(engine.devices, device), device);
      const added = when ? t("Added {date}", { date: when }) : null;
      return { current, text: [state, session?.location, added].filter(Boolean).join(" · ") };
    };
    const confirmRemove = (device, onDone) =>
      dialog(t("Remove this device?"), (body, actions, { close }) => {
        describe(
          body,
          t(
            "{name} is signed out and can't read new encrypted messages. To read them there again, it needs your recovery code, your password, or approval from another device.",
            { name: deviceTitle(device) ?? t("This browser") },
          ),
        );
        const error = document.createElement("p");
        error.className = "fe2ee-error";
        error.setAttribute("role", "alert");
        error.hidden = true;
        body.append(error);
        const confirm = button(t("Remove device"), "danger", async () => {
          confirm.disabled = true;
          try {
            await engine.removeDevice(device.device_id);
            close();
            onDone();
          } catch (failure) {
            error.textContent = t("Couldn't remove it. {error}", { error: errorText(failure) });
            error.hidden = false;
            confirm.disabled = false;
          }
        });
        actions.append(button(t("Cancel"), "secondary", close), confirm);
      });
    const buildSettings = (root, close) => {
      const browser = section(t("This browser"));
      const backupSection = section(t("Key backup"));
      const devices = section(
        t("Your devices"),
        t(
          "Unlocked browsers can read your encrypted messages, and browsers waiting for approval can once you approve them. Remove the ones you don't recognize or don't use anymore.",
        ),
      );
      const resetSection = section(t("Reset encryption"));
      const resetText = describe(resetSection, "");
      const list = document.createElement("div");
      list.className = "fe2ee-devices";
      const inviteError = document.createElement("p");
      inviteError.className = "fe2ee-error";
      inviteError.setAttribute("role", "alert");
      inviteError.hidden = true;
      devices.append(list, inviteError);
      resetSection.append(button(t("Reset encryption"), "danger", () => showReset()));
      const renderReset = () => {
        const text =
          engine.backup?.mode === "recovery"
            ? t(
                "If you lost your recovery code and no other browser can approve a new one, reset encryption to keep chatting. Messages sent before the reset can't be read anymore.",
              )
            : t(
                "If your password doesn't unlock your keys and no other browser can approve a new one, reset encryption to keep chatting. Messages sent before the reset can't be read anymore.",
              );
        if (resetText.textContent !== text) resetText.textContent = text;
      };
      const advanced = section(t("Advanced safety checks"));
      const strictLabel = document.createElement("label");
      strictLabel.className = "fe2ee-safety-option";
      const strict = document.createElement("input");
      strict.type = "checkbox";
      strict.checked = !engine.trustsServer;
      strict.addEventListener("change", () => {
        if (strict.checked) browserStorage?.setItem("fosscord-e2ee-strict-safety", "true");
        else browserStorage?.removeItem("fosscord-e2ee-strict-safety");
        engine.invalidateAll();
        refresh();
      });
      strictLabel.append(
        strict,
        document.createTextNode(t("Review safety number changes and new browser approvals")),
      );
      advanced.append(strictLabel);
      describe(
        advanced,
        t(
          "By default, this browser trusts this instance's signed-in sessions and key directory. The instance also stores an encrypted recovery copy of your backup secret, so your account password can recover this browser. Safety checks apply in this browser and do not erase a recovery copy already stored by another browser.",
        ),
      );
      root.append(browser, backupSection, devices, resetSection, advanced);
      const clear = (el) =>
        el.querySelectorAll(":scope > :not(h3)").forEach((child) => child.remove());
      const renderBrowser = () => {
        clear(browser);
        describe(
          browser,
          engine.linked
            ? t("Unlocked. This browser can read and send encrypted messages.")
            : t("Locked. This browser can't read encrypted messages yet."),
        );
        if (!engine.linked)
          browser.append(
            button(t("Unlock this browser"), "primary", () => {
              close?.();
              showUnlock();
            }),
          );
      };
      let backupKey = "";
      const renderBackup = (force = false) => {
        const backup = engine.backup;
        const key = `${backup?.mode}|${backup?.version}|${!!backup?.wrapped_secret}|${engine.hasSecret}|${engine.backupNeedsPassword}`;
        if (!force && key === backupKey) return;
        backupKey = key;
        clear(backupSection);
        backupSection.dataset.mode = backup?.mode ?? "none";
        if (engine.backupNeedsPassword) {
          describe(
            backupSection,
            t(
              "Your keys aren't backed up yet, so new browsers can't read your encrypted messages. Enter your account password to back them up.",
            ),
          );
          backupSection.append(backupPasswordForm(() => renderBackup(true)));
          return;
        }
        if (!backup)
          return void describe(
            backupSection,
            t(
              "Your keys aren't backed up yet. Open the app on a browser that can read your messages to back them up.",
            ),
          );
        if (backup.mode === "recovery")
          describe(
            backupSection,
            t(
              "Your keys have a recovery-code backup. In trusted-server mode, your account password can also recover a browser through the instance; advanced safety mode uses your recovery code or another device.",
            ),
          );
        else if (backup.wrapped_secret)
          describe(
            backupSection,
            t(
              "Your keys are backed up and locked with your account password, so new browsers unlock as soon as you sign in. Someone with a copy of the server's database could try to guess a weak password offline.",
            ),
          );
        else
          describe(
            backupSection,
            t(
              "Your keys are backed up, but they aren't locked with your password yet. Open the app on a browser that can read your messages to finish the backup.",
            ),
          );
        if (!engine.hasSecret) return;
        if (backup.mode === "password") {
          backupSection.append(
            button(t("Use a recovery code instead"), "secondary", () => {
              close?.();
              showRecoveryCode();
            }),
          );
          return;
        }
        const { wrap, input, row, setError } = field(
          t("Account password"),
          "password",
          "current-password",
        );
        const save = button(t("Use my password instead"), "secondary", async () => {
          if (!input.value) return setError(t("Enter your password."));
          save.disabled = true;
          setError(null);
          try {
            if (!(await verifyPassword(input.value)))
              return setError(t("That password isn't right."));
            await engine.setBackupMode("password", input.value);
            renderBackup(true);
          } catch (error) {
            setError(errorText(error));
          } finally {
            save.disabled = false;
          }
        });
        input.addEventListener("keydown", (event) => event.key === "Enter" && save.click());
        row.append(save);
        backupSection.append(
          wrap,
          button(t("Make a new recovery code"), "secondary", () => {
            close?.();
            showRecoveryCode();
          }),
        );
      };
      const renderDevices = () => {
        list.replaceChildren();
        const active = engine.devices
          .filter((d) => d.status !== "revoked")
          .sort(
            (a, b) =>
              Number(b.device_id === engine.device?.deviceId) -
                Number(a.device_id === engine.device?.deviceId) ||
              Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""),
          );
        for (const device of active) {
          const row = document.createElement("div");
          row.className = "fe2ee-device";
          const { current, text } = deviceMeta(device);
          row.innerHTML = `<div class="fe2ee-device-icon">${svg(SCREEN_PATH)}</div><div class="fe2ee-device-text"><span class="fe2ee-device-name">${escape(deviceTitle(device) ?? t("Unknown browser"))}</span><span class="fe2ee-device-meta" data-current="${current}">${escape(text)}</span></div>`;
          const buttons = document.createElement("div");
          buttons.className = "fe2ee-device-actions";
          if (!current && device.status === "pending" && engine.linked && engine.hasSecret) {
            const asked = (invited.get(device.device_id) ?? 0) > Date.now();
            const approve = button(asked ? t("Asked") : t("Approve"), "primary", async () => {
              invited.set(device.device_id, Date.now() + INVITE_MS);
              setTimeout(renderDevices, INVITE_MS + 50);
              renderDevices();
              inviteError.hidden = true;
              try {
                await link.invite(device.device_id);
              } catch (error) {
                invited.delete(device.device_id);
                renderDevices();
                inviteError.textContent = t("Couldn't ask that browser for approval. {error}", {
                  error: errorText(error),
                });
                inviteError.hidden = false;
              }
            });
            approve.disabled = asked;
            if (asked)
              approve.title = t(
                "That browser shows a code and asks you to approve it here once it's open.",
              );
            buttons.append(approve);
          }
          if (!current)
            buttons.append(
              button(t("Remove"), "secondary", () => confirmRemove(device, renderDevices)),
            );
          if (buttons.childElementCount) row.append(buttons);
          list.append(row);
        }
      };
      const render = () => {
        renderBrowser();
        renderBackup();
        renderDevices();
        renderReset();
      };
      render();
      engine.reloadBackup().then(
        () => renderBackup(true),
        () => {},
      );
      engine.refresh().catch(() => {});
      return engine.onChange(render);
    };
    const showSettings = () =>
      dialog(t("Encryption settings"), (body, actions, { el, close }) => {
        const stop = buildSettings(body, close);
        el.addEventListener("close", () => stop());
        actions.append(button(t("Done"), "primary", close));
      });
    const mountSettings = (container) => {
      mount();
      const root = document.createElement("div");
      root.className = "fe2ee-page";
      container.replaceChildren(root);
      if (!engine.userId) {
        describe(root, failure ?? paused ?? t("Encryption is still starting up."));
        return () => {};
      }
      const stop = buildSettings(root);
      return () => {
        stop();
        root.remove();
      };
    };
    const pauseForChange = (channelId, changed) => {
      flash(channelId, {
        tone: "warning",
        text: t(
          "{name}'s safety number changed. Review it before sending. Your message is still in the text box.",
          { name: memberName(changed) },
        ),
        action: { label: t("Review"), run: () => showSafety(channelId) },
      });
      return true;
    };
    const changedMember = async (channelId) => {
      const ids = await engine.channelMembers(channelId);
      await engine.keysFor(ids);
      const id = ids.find((m) => engine.contacts[m]?.pendingKey);
      return id ? engine.profile(id) : null;
    };
    const beforeSend = async (channelId) => {
      if (!engine.isEncrypted(channelId)) return false;
      if (!(await ready)) {
        flash(channelId, {
          tone: "danger",
          text: failure ?? t("Encryption is unavailable in this client build"),
        });
        return true;
      }
      if (failure) {
        flash(channelId, { tone: "danger", text: failure });
        return true;
      }
      if (paused) {
        flash(channelId, { tone: "warning", text: paused });
        return true;
      }
      const changed =
        members?.channelId === channelId
          ? members.list.find((m) => engine.contacts[m.id]?.pendingKey)
          : undefined;
      if (changed && !engine.trustsServer) return pauseForChange(channelId, changed);
      if (engine.locked) {
        if (engine.trustsServer) {
          link.request().catch(() => {});
          showRequiredPassword();
          flash(channelId, {
            tone: "info",
            text: t("Preparing private chat… Your message is still in the text box."),
          });
          return true;
        }
        showUnlock();
        flash(channelId, {
          tone: "warning",
          text: t(
            "Unlock this browser to send encrypted messages. Your message is still in the text box.",
          ),
          action: { label: t("Unlock"), run: showUnlock },
        });
        return true;
      }
      if (!engine.trustsServer) {
        const checked = await Promise.race([
          changedMember(channelId).catch(() => null),
          new Promise((resolve) => void setTimeout(() => resolve(null), 3000)),
        ]);
        return checked ? pauseForChange(channelId, checked) : false;
      }
      const prepared = await Promise.race([
        engine
          .channelMembers(channelId)
          .then((ids) => engine.keysFor(ids))
          .then((entries) =>
            entries.every((entry) => entry.devices.some((device) => device.status === "active")),
          )
          .catch(() => false),
        new Promise((resolve) => void setTimeout(() => resolve(false), 3000)),
      ]);
      if (!prepared)
        flash(channelId, {
          tone: "info",
          text: t("Preparing private chat… Your message is still in the text box."),
        });
      return !prepared;
    };
    const decorateMessages = () => {
      for (const [id, info] of states) {
        const content = document.getElementById(`message-content-${id}`);
        if (!content) continue;
        if (info.state === "decrypted") delete content.dataset.fe2eeState;
        else if (content.dataset.fe2eeState !== info.state) content.dataset.fe2eeState = info.state;
        content.querySelectorAll(".fe2ee-lock, .fe2ee-unlock").forEach((el) => el.remove());
      }
    };
    const headerLabel = (channelId) => {
      if (!engine.isEncrypted(channelId)) return t("Turn On Encryption");
      if (!bootstrapped) return t("Preparing private chat…");
      const list = members?.channelId === channelId ? members.list : [];
      if (!engine.trustsServer && list.some((m) => engine.contacts[m.id]?.pendingKey))
        return t("Safety Number Changed");
      if (list.length && list.every((m) => engine.contacts[m.id]?.verified))
        return t("Encrypted and Verified");
      return t(engine.trustsServer ? "Encrypted" : "End-to-End Encrypted");
    };
    const decorateHeader = (channelId) => {
      const existing = document.querySelector(".fe2ee-toggle");
      if (!channelId) return existing?.remove();
      const toolbars = [...document.querySelectorAll('[class*="toolbar__"]')];
      const toolbar =
        toolbars.find((t) => t.parentElement?.className.includes("upperContainer")) ?? toolbars[0];
      if (!toolbar) return;
      const on = engine.isEncrypted(channelId);
      const list = members?.channelId === channelId ? members.list : [];
      const verified =
        on &&
        list.length > 0 &&
        list.every((m) => engine.contacts[m.id]?.verified && !engine.contacts[m.id]?.pendingKey);
      let toggle = existing;
      if (!toggle || toggle.parentElement !== toolbar) {
        toggle?.remove();
        toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "fe2ee-toggle";
        toggle.addEventListener("click", () => {
          const id = currentChannel();
          if (!id) return;
          if (engine.isEncrypted(id)) showSafety(id);
          else confirmEnable(id);
        });
        withTooltip(toggle, () => headerLabel(currentChannel() ?? ""));
        toolbar.prepend(toggle);
      }
      const label = headerLabel(channelId);
      toggle.disabled = on && !bootstrapped;
      const key = `${on}|${verified}|${label}`;
      if (toggle.dataset.key === key) return;
      toggle.dataset.key = key;
      toggle.dataset.verified = String(verified);
      toggle.setAttribute("aria-pressed", String(on));
      toggle.setAttribute(
        "aria-label",
        on
          ? t("{label}. View safety numbers", { label: headerLabel(channelId) })
          : t("Turn on end-to-end encryption"),
      );
      toggle.innerHTML = svg(verified ? VERIFIED_PATH : on ? LOCK_PATH : OPEN_LOCK_PATH);
    };
    const currentNotice = (channelId) => {
      if (!channelId) return null;
      const temporary =
        transient && transient.channelId === channelId && transient.until > Date.now()
          ? transient
          : null;
      if (!engine.isEncrypted(channelId)) return temporary;
      if (failure) return { tone: "danger", text: failure };
      if (paused) return { tone: "warning", text: paused };
      if (!bootstrapped) return { tone: "info", text: t("Preparing private chat…") };
      const changed =
        members?.channelId === channelId
          ? members.list.find((m) => engine.contacts[m.id]?.pendingKey)
          : undefined;
      if (changed && !engine.trustsServer)
        return {
          tone: "warning",
          text: t("{name}'s safety number changed. Sending is paused until you review it.", {
            name: memberName(changed),
          }),
          action: { label: t("Review"), run: () => showSafety(channelId) },
        };
      if (temporary) return temporary;
      if (engine.locked)
        return engine.trustsServer
          ? {
              tone: "info",
              text: t("Unlock this browser to read and send encrypted messages here."),
              action: { label: t("Unlock"), run: showRequiredPassword },
            }
          : {
              tone: "info",
              text: t("Unlock this browser to read and send encrypted messages here."),
              action: { label: t("Unlock"), run: showUnlock },
            };
      if (!engine.trustsServer && engine.backupNeedsPassword && !backupPromptDismissed)
        return {
          tone: "info",
          text: t(
            "Back up your encryption keys with your password so your other browsers can read your encrypted messages.",
          ),
          action: {
            label: t("Back up"),
            run: () => {
              backupPromptDismissed = true;
              refresh();
              showBackupPassword();
            },
          },
        };
      return null;
    };
    const decorateNotice = (channelId) => {
      const notice = currentNotice(channelId);
      const form = document.querySelector('[role="textbox"]')?.closest("form");
      if (!notice || !form) return bar.remove();
      if (bar.parentElement !== form || form.firstElementChild !== bar) form.prepend(bar);
      const key = `${notice.tone}|${notice.text}|${notice.action?.label ?? ""}`;
      if (bar.dataset.key === key) return;
      bar.dataset.key = key;
      bar.dataset.tone = notice.tone;
      bar.setAttribute("role", notice.tone === "danger" ? "alert" : "status");
      bar.innerHTML = `${svg(notice.tone === "info" ? LOCK_PATH : OPEN_LOCK_PATH)}<p>${escape(notice.text)}</p>`;
      if (notice.action) {
        const { run } = notice.action;
        bar.append(button(notice.action.label, "secondary", run));
      }
    };
    const refresh = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        mount();
        const channelId = currentChannel();
        if (bootstrapped && channelId && engine.userId && members?.channelId !== channelId)
          loadMembers(channelId);
        if (tooltip && !document.querySelector(".fe2ee-toggle:hover, .fe2ee-lock:hover"))
          hideTooltip();
        decorateMessages();
        decorateHeader(channelId);
        decorateNotice(channelId);
        const needsPassword =
          bootstrapped &&
          !failure &&
          engine.trustsServer &&
          engine.locked &&
          !!channelId &&
          engine.isEncrypted(channelId);
        if (!needsPassword && passwordPromptTimer) {
          clearTimeout(passwordPromptTimer);
          passwordPromptTimer = null;
        }
        if (needsPassword && !requiredPasswordOpen && !passwordPromptTimer) {
          passwordPromptTimer = setTimeout(() => {
            passwordPromptTimer = null;
            const current = currentChannel();
            if (current && engine.isEncrypted(current)) showRequiredPassword();
          }, 8000);
        }
      });
    };
    const start = () => {
      mount();
      new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true });
      engine.onChange(refresh);
      refresh();
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
    return {
      refresh,
      showError,
      showUnlock,
      unlockSnoozed,
      showApproval,
      dismissApproval,
      showSettings,
      mountSettings,
      beforeSend,
      renderUnlock: () => unlockOpen?.render(),
      fail: (text) => {
        failure = text;
        refresh();
      },
      pause: (text) => {
        paused = text;
        refresh();
      },
    };
  };

  // client/e2ee/src/webpack.ts
  var keysOf = (value) => {
    try {
      return value && (typeof value === "object" || typeof value === "function")
        ? Object.keys(value)
        : [];
    } catch {
      return [];
    }
  };
  var protoKeysOf = (value) => {
    try {
      const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
      return proto && proto !== Object.prototype ? Object.getOwnPropertyNames(proto) : [];
    } catch {
      return [];
    }
  };
  var pickRequire = (reqs) =>
    reqs
      .filter((r) => r.c)
      .reduce(
        (best, r) => (!best || Object.keys(r.c).length > Object.keys(best.c).length ? r : best),
        null,
      );
  var scan = (reqs, found) => {
    const req = pickRequire(reqs);
    if (!req?.c) return found;
    for (const id of Object.keys(req.c)) {
      if (found.dispatcher && found.http && found.gateway) break;
      const exports = req.c[id]?.exports;
      for (const name of keysOf(exports)) {
        let value;
        try {
          value = exports[name];
        } catch {
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const own = keysOf(value);
        const proto = protoKeysOf(value);
        const all = new Set([...own, ...proto]);
        if (
          !found.dispatcher &&
          ["addInterceptor", "dispatch", "subscribe"].every((k) => all.has(k))
        )
          found.dispatcher = value;
        else if (
          !found.http &&
          own.length <= 6 &&
          ["get", "post", "put", "patch", "del"].every(
            (k) => own.includes(k) && typeof value[k] === "function",
          )
        )
          found.http = value;
        else if (
          !found.gateway &&
          proto.includes("getSocket") &&
          proto.includes("isTryingToConnect")
        ) {
          try {
            const socket = value.getSocket();
            if (socket && keysOf(socket.dispatcher).includes("getDispatchHandler"))
              found.gateway = value;
          } catch {
            continue;
          }
        }
      }
    }
    return found;
  };
  var findStore = (reqs, methods) => {
    const req = pickRequire(reqs);
    if (!req?.c) return null;
    for (const id of Object.keys(req.c)) {
      const exports = req.c[id]?.exports;
      for (const name of keysOf(exports)) {
        let value;
        try {
          value = exports[name];
        } catch {
          continue;
        }
        if (!value || typeof value !== "object") continue;
        const proto = protoKeysOf(value);
        if (methods.every((m) => proto.includes(m))) return value;
      }
    }
    return null;
  };

  // client/e2ee/src/index.ts
  var HOOK_TIMEOUT_MS = 20000;
  var loader = (window.__fosscordE2ee ??= { reqs: [] });
  var states = new Map();
  var targets = {};
  var http = null;
  var failure = null;
  var settle = () => {};
  var ready = new Promise((resolve) => {
    settle = resolve;
  });
  var started = false;
  var initialized = false;
  var signedOut = false;
  var lastProbe = -Infinity;
  var probing = false;
  var api = {
    async request(method, url, body) {
      if (!http) throw new Error("HTTP client not found");
      if (signedOut)
        throw { ok: false, status: 401, body: { message: "This session was signed out" } };
      const requestingUser = engine.userId;
      const res = await http[method]({
        url,
        body,
        rejectWithError: false,
        timeout: 15000,
        retries: 0,
      }).catch((error) => {
        if (error?.status === 401 && requestingUser && requestingUser === engine.userId)
          sessionEnded();
        throw error;
      });
      if (res.status === 401 && requestingUser && requestingUser === engine.userId) sessionEnded();
      if (!res.ok) throw res;
      return res.body;
    },
  };
  var nativeChannels = null;
  var classifyChannel = (channelId) => {
    nativeChannels ??= findStore(loader.reqs, ["getChannel", "getDMFromUserId"]);
    const channel = nativeChannels?.getChannel(channelId);
    if (channel?.e2ee_enabled) return true;
    return channel
      ? channel.type === 1 || channel.type === 3
      : location.pathname === `/channels/@me/${channelId}`;
  };
  var trustsServer = () =>
    window.GLOBAL_ENV?.E2EE_TRUST_SERVER !== false &&
    browserStorage?.getItem("fosscord-e2ee-strict-safety") !== "true";
  var engine = new Engine(api, classifyChannel, trustsServer);
  var attachments = createAttachments();
  attachments.start();
  var stickerStore = null;
  var sticker = (id) => {
    stickerStore ??= findStore(loader.reqs, ["getStickerById", "getStickerPack"]);
    const found = stickerStore?.getStickerById(id);
    return found
      ? { id, name: String(found.name ?? ""), format_type: Number(found.format_type ?? 1) }
      : null;
  };
  var apiBase = () => {
    const env = window.GLOBAL_ENV;
    return `${env?.API_ENDPOINT ?? "/api"}/v${env?.API_VERSION ?? 9}`;
  };
  var storedToken = () => {
    try {
      const value = JSON.parse(browserStorage?.getItem("token") ?? "null");
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };
  var link = createLink(engine, api, {
    onPrompt: (prompt) => {
      if (!engine.trustsServer) ui.showApproval(prompt);
      else if (prompt.autoApprove)
        prompt
          .approve()
          .catch((error) => console.error("[e2ee] automatic browser linking failed", error));
    },
    onChange: () => ui.renderUnlock(),
    onDismiss: (requestId) => ui.dismissApproval(requestId),
    onPeerUnlock: () => {
      if (initialized && !signedOut && engine.locked)
        engine.refresh().catch((error) => console.error("[e2ee] refresh failed", error));
    },
    onPeerReset: () => {
      if (initialized && !signedOut)
        engine.refresh().catch((error) => console.error("[e2ee] refresh failed", error));
    },
    beacon: (body) => {
      const token = storedToken();
      if (!token) return;
      fetch(`${apiBase()}/users/@me/e2ee/link`, {
        method: "POST",
        keepalive: true,
        headers: { "content-type": "application/json", authorization: token },
        body: JSON.stringify(body),
      }).catch(() => {});
    },
  });
  var tokenApi = (token) => ({
    async request(method, url, body) {
      const res = await fetch(`${apiBase()}${url}`, {
        method: method === "del" ? "DELETE" : method.toUpperCase(),
        headers: { "content-type": "application/json", authorization: token },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = await res.json().catch(() => null);
      if (!res.ok) throw { ok: false, status: res.status, body: parsed };
      return parsed;
    },
  });
  var verifyPassword = async (password) => {
    try {
      await api.request("post", "/users/@me/e2ee/password", { password });
      return true;
    } catch (error) {
      if (error?.status === 400) return false;
      throw error;
    }
  };
  var ui = createUi({
    engine,
    ready,
    states,
    link,
    verifyPassword,
    reset: (password) => engine.reset(password),
    enableChannel: async (channelId) => {
      await api.request("put", `/channels/${channelId}/e2ee`, { enabled: true });
      engine.setChannelEncrypted(channelId);
    },
  });
  function sessionEnded() {
    if (signedOut) return;
    signedOut = true;
    console.warn("[e2ee] this tab's session isn't valid anymore, so it stops handling encryption");
    link.stop();
  }
  var describeError = (error) => {
    if (error instanceof Error) return error.message;
    const response = error;
    if (typeof response?.status !== "number") return String(error);
    return `HTTP ${response.status}${typeof response.body?.message === "string" ? ` ${response.body.message}` : ""}`;
  };
  var fail = (reason) => {
    if (failure) return;
    failure = reason;
    console.error(`[e2ee] ${reason}`);
    ui.fail(
      t(
        "End-to-end encryption is unavailable in this client build, so sending in encrypted conversations is turned off.",
      ),
    );
    settle(false);
  };
  var readyNow = false;
  ready.then((ok) => {
    readyNow = ok;
    if (ok) hooks.retryAll();
  });
  var hooks = createHooks({
    fetchEmbeds: async (urls) => (await api.request("post", "/e2ee/embeds", { urls })).embeds ?? {},
    fetchSoundmoji: async (refs) =>
      (await api.request("post", "/e2ee/soundmoji", { refs })).sounds ?? [],
    engine,
    attachments,
    sticker,
    ready,
    states,
    failClosed: () => failure !== null,
    isReady: () => readyNow,
    onLogout: () => {
      loggedOut = true;
      link.stop();
      engine
        .forget()
        .catch((error) => console.error("[e2ee] couldn't remove this browser's keys", error));
    },
    onCredentials: (path, body, response) => {
      const password = typeof body.password === "string" ? body.password : undefined;
      const next = typeof body.new_password === "string" ? body.new_password : undefined;
      if (path !== "/users/@me") {
        const userId = response?.user_id;
        return (
          password &&
          engine.rememberPassword(password, typeof userId === "string" ? userId : undefined)
        );
      }
      if (!next) return;
      const token = response?.token;
      engine
        .passwordChanged(password, next, typeof token === "string" ? tokenApi(token) : undefined)
        .catch((error) => console.error("[e2ee] couldn't rewrap the backup", error));
    },
    onState: () => ui.refresh(),
    updateRecord: (message) => {
      try {
        loader.updateMessage?.(message.channel_id, message.id, {
          content: message.content ?? "",
          stickerItems: message.sticker_items ?? [],
          ...(message.soundboard_sounds?.length
            ? { soundboardSounds: message.soundboard_sounds }
            : {}),
        });
      } catch (error) {
        console.error("[e2ee] couldn't refresh a decrypted message", error);
      }
    },
    onError: (error, channelId) => ui.showError(error, channelId),
  });
  var selfTest = async () => {
    const agreement = await generateAgreementKey();
    const secret = randomBytes(32);
    const sealed = await hpkeSeal(
      await exportPublic(agreement.publicKey),
      secret,
      "self-test",
      "aad",
    );
    const opened = await hpkeOpen(agreement, sealed.enc, sealed.wrapped, "self-test", "aad");
    if (toB64u(opened) !== toB64u(secret)) throw new Error("HPKE round trip failed");
    const iv = randomBytes(12);
    const ct = await aesEncrypt(secret, iv, secret, "aad");
    if (toB64u(await aesDecrypt(secret, iv, ct, "aad")) !== toB64u(secret))
      throw new Error("AES-GCM round trip failed");
    const signing = await generateSigningKey();
    const signature = await sign(signing.privateKey, "self-test");
    if (!(await verify(await exportPublic(signing.publicKey), "self-test", signature)))
      throw new Error("Ed25519 round trip failed");
    if (await verify(await exportPublic(signing.publicKey), "self-tesT", signature))
      throw new Error("Ed25519 accepted a bad signature");
    const prekey = engine.prekeys.reduce((a, b) => (b.id > a.id ? b : a));
    const probe = await hpkeSeal(prekey.publicKey, secret, "self-test", "aad");
    if (
      toB64u(await hpkeOpen(prekey.keyPair, probe.enc, probe.wrapped, "self-test", "aad")) !==
      toB64u(secret)
    )
      throw new Error("Stored prekey round trip failed");
  };
  var startAttempts = 0;
  var start = async (userId) => {
    if (started || failure || signedOut) return;
    started = true;
    try {
      await engine.init(userId);
      ui.pause(null);
      await selfTest();
      attachments.ready().then((controlled) => {
        if (!controlled)
          console.warn(
            "[e2ee] the attachment service worker isn't controlling this page, so encrypted files won't load",
          );
      });
      initialized = true;
      link.start(userId);
      engine.onUnlock(() => {
        hooks.retryAll();
        if (engine.linked) {
          link.cancel();
          link.unlocked();
        }
      });
      engine.onWipe(() => {
        link.reset();
        if (engine.locked && !ui.unlockSnoozed()) link.request().catch(() => {});
      });
      let wasLinked = engine.linked;
      engine.onChange(() => {
        if (wasLinked && engine.locked && !ui.unlockSnoozed()) link.request().catch(() => {});
        wasLinked = engine.linked;
        link.devicesChanged();
      });
      ui.refresh();
      if (engine.locked && engine.encryptedChannels.size && !ui.unlockSnoozed())
        link.request().catch(() => {});
    } catch (error) {
      const response = error;
      if (typeof response?.status !== "number")
        return fail(`Self-test failed: ${describeError(error)}`);
      const retryAfter = Number(response.body?.retry_after);
      const limited = response.status === 429 && retryAfter > 0;
      const delay = limited
        ? Math.ceil(retryAfter) * 1000 + 1000
        : Math.min(5000 * 2 ** startAttempts, 300000);
      startAttempts++;
      console.warn(
        `[e2ee] couldn't start (${describeError(error)}), retrying in ${Math.round(delay / 1000)}s`,
      );
      ui.pause(
        limited
          ? t(
              "Encryption is paused because this account set up too many browsers recently. It will try again at {time}.",
              {
                time: new Date(Date.now() + delay).toLocaleTimeString(locale(), {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              },
            )
          : t(
              "Encryption couldn't reach the server, so sending in encrypted conversations is paused. It will try again shortly.",
            ),
      );
      setTimeout(() => {
        started = false;
        start(userId);
      }, delay);
    }
  };
  var startWhenReady = () => {
    if (
      started ||
      probing ||
      failure ||
      signedOut ||
      loggedOut ||
      !http ||
      Date.now() - lastProbe < 1e4
    )
      return;
    lastProbe = Date.now();
    probing = true;
    api
      .request("get", "/users/@me")
      .then(
        (me) => {
          if (!loggedOut && !signedOut && typeof me?.id === "string" && /^[0-9]+$/.test(me.id))
            return start(me.id);
        },
        () => {},
      )
      .finally(() => {
        probing = false;
      });
  };
  var received = {};
  var count = (type) => (received[type] = (received[type] ?? 0) + 1);
  var selfRefresh = null;
  var loggedOut = false;
  var refreshSelf = (userId) => {
    if (userId !== engine.userId || !initialized || selfRefresh || signedOut) return;
    selfRefresh = setTimeout(() => {
      selfRefresh = null;
      engine.refresh().catch((error) => console.error("[e2ee] refresh failed", error));
    }, 500);
  };
  var custom = {
    E2EE_DEVICES_UPDATE: (data) => {
      count("E2EE_DEVICES_UPDATE");
      engine.invalidateUser(String(data.user_id));
      refreshSelf(String(data.user_id));
      ui.refresh();
    },
    E2EE_IDENTITY_UPDATE: (data) => {
      count("E2EE_IDENTITY_UPDATE");
      const userId = String(data.user_id);
      engine.invalidateUser(userId);
      refreshSelf(userId);
      if (initialized && !signedOut && userId !== engine.userId)
        engine
          .keysFor([userId])
          .catch((error) => console.error("[e2ee] couldn't check the new safety number", error));
      ui.refresh();
    },
    E2EE_TRUST_UPDATE: () => {
      count("E2EE_TRUST_UPDATE");
      if (initialized && !signedOut)
        engine
          .syncTrust()
          .catch((error) => console.error("[e2ee] couldn't sync verifications", error));
    },
    E2EE_LINK_REQUEST: (data) => {
      count("E2EE_LINK_REQUEST");
      if (initialized) link.onEvent("E2EE_LINK_REQUEST", data);
    },
    E2EE_LINK_RESPONSE: (data) => {
      count("E2EE_LINK_RESPONSE");
      if (initialized) link.onEvent("E2EE_LINK_RESPONSE", data);
    },
    CHANNEL_E2EE_UPDATE: (data) => {
      count("CHANNEL_E2EE_UPDATE");
      if (data.enabled) engine.setChannelEncrypted(String(data.channel_id));
    },
  };
  var installed = { dispatcher: false, http: false, gateway: false };
  var startedAt = Date.now();
  var tick = () => {
    if (failure) return;
    scan(loader.reqs, targets);
    if (targets.http && !installed.http) {
      installed.http = true;
      const originals = hooks.wrapHttp(targets.http);
      http = originals;
    }
    if (targets.dispatcher && !installed.dispatcher) {
      installed.dispatcher = true;
      hooks.watchDispatcher(targets.dispatcher);
      targets.dispatcher.subscribe("LOGOUT", () => {
        loggedOut = true;
        link.stop();
      });
      targets.dispatcher.subscribe("CONNECTION_OPEN", (action) => {
        if (loggedOut) return location.reload();
        const user = action.user;
        if (user?.id) start(user.id);
        else startWhenReady();
      });
      targets.dispatcher.subscribe("CHANNEL_RECIPIENT_ADD", (action) =>
        engine.invalidateChannel(String(action.channelId)),
      );
      targets.dispatcher.subscribe("CHANNEL_RECIPIENT_REMOVE", (action) =>
        engine.invalidateChannel(String(action.channelId)),
      );
    }
    if (
      targets.gateway &&
      !installed.gateway &&
      targets.gateway.getSocket().dispatcher.getDispatchHandler
    ) {
      installed.gateway = true;
      hooks.wrapGateway(targets.gateway, custom);
    }
    if (installed.http && installed.dispatcher && installed.gateway) {
      if (initialized) return settle(true);
      if (!started && Date.now() - startedAt > 8000) startWhenReady();
    } else if (Date.now() - startedAt > HOOK_TIMEOUT_MS) {
      const missing = Object.entries(installed)
        .filter(([, ok]) => !ok)
        .map(([name]) => name);
      return fail(`Couldn't find ${missing.join(", ")} in this client build`);
    }
    setTimeout(tick, installed.http && installed.dispatcher ? 100 : 20);
  };
  loader.status = () => ({
    ready: initialized && !failure && installed.http && installed.dispatcher && installed.gateway,
    trustsServer: engine.trustsServer,
    serverRecoveryReady: engine.serverRecoveryReady,
    failure,
    userId: engine.userId,
    deviceId: engine.device?.deviceId ?? null,
    deviceStatus: engine.deviceStatus,
    linked: engine.linked,
    locked: engine.locked,
    holdsIdentity: !!engine.identity,
    trustedKey: engine.trustedKey,
    hasSecret: engine.hasSecret,
    backup: engine.backup
      ? {
          mode: engine.backup.mode,
          version: engine.backup.version,
          hasSecret: !!engine.backup.wrapped_secret,
          identityKey: engine.backup.identity_key,
        }
      : null,
    link: link.outgoing(),
    hooks: { ...installed },
    encryptedChannels: [...engine.encryptedChannels],
    states: Object.fromEntries(states),
    received: { ...received },
  });
  loader.isEncrypted = (channelId) => engine.isEncrypted(channelId);
  loader.beforeSend = (channelId) => ui.beforeSend(channelId);
  loader.mountSettings = (container) => ui.mountSettings(container);
  loader.openSettings = () => ui.showSettings();
  tick();
})();
