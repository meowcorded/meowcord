import { connect as connectTcp, isIP, Socket } from "node:net";
import { connect as connectTls } from "node:tls";

export type OutboundProxy = { host: string; port: number };

export type RawExchange = {
    status: number;
    headers: [string, string][];
    body: Buffer | null;
};

const HEADER_LIMIT = 64 * 1024;

export const outboundProxy = (): OutboundProxy | "direct" | null => {
    const setting = process.env.PUBLIC_FETCH_PROXY?.trim();
    if (!setting) return null;
    if (setting === "direct") return "direct";
    if (!URL.canParse(setting)) throw new Error("PUBLIC_FETCH_PROXY is not a valid URL");
    const proxy = new URL(setting);
    if (proxy.protocol !== "socks5:" && proxy.protocol !== "socks5h:") throw new Error("PUBLIC_FETCH_PROXY must be a socks5:// URL or direct");
    return { host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port || 1080) };
};

export type OutboundProxyStatus = { mode: "proxy" | "direct" | "unset" | "invalid"; proxy?: OutboundProxy; problem?: string };

export const outboundProxyStatus = (): OutboundProxyStatus => {
    const refused = "link previews, components media, webhook avatar_url images and the /external media proxy refuse every public URL";
    try {
        const proxy = outboundProxy();
        if (proxy === "direct") return { mode: "direct", problem: "PUBLIC_FETCH_PROXY is direct, so fetches of user-chosen URLs leave from this server's own address" };
        if (!proxy) return { mode: "unset", problem: `PUBLIC_FETCH_PROXY is not set, so ${refused}. Set it to a socks5:// URL` };
        return { mode: "proxy", proxy };
    } catch (error) {
        return { mode: "invalid", problem: `${(error as Error).message}, so ${refused}` };
    }
};

class SocketReader {
    private chunks: Buffer[] = [];
    private buffered = 0;
    private ended = false;
    private failure: Error | null = null;
    private waiting: (() => void) | null = null;

    constructor(private socket: Socket) {
        socket.on("data", (chunk: Buffer) => {
            this.chunks.push(chunk);
            this.buffered += chunk.length;
            this.wake();
        });
        socket.on("end", () => {
            this.ended = true;
            this.wake();
        });
        socket.on("close", () => {
            this.ended = true;
            this.wake();
        });
        socket.on("error", (error) => {
            this.failure = error;
            this.wake();
        });
    }

    private wake() {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.();
    }

    private async more() {
        if (this.failure) throw this.failure;
        if (this.ended) return false;
        await new Promise<void>((resolve) => (this.waiting = resolve));
        if (this.failure) throw this.failure;
        return true;
    }

    private take(length: number) {
        const all = Buffer.concat(this.chunks, this.buffered);
        this.chunks = all.length > length ? [all.subarray(length)] : [];
        this.buffered = all.length - length;
        return all.subarray(0, length);
    }

    detach() {
        this.socket.removeAllListeners("data");
        const rest = Buffer.concat(this.chunks, this.buffered);
        this.chunks = [];
        this.buffered = 0;
        return rest;
    }

    async exactly(length: number) {
        while (this.buffered < length) if (!(await this.more())) throw new Error("Connection closed early");
        return this.take(length);
    }

    async until(marker: string, limit: number) {
        for (;;) {
            const index = Buffer.concat(this.chunks, this.buffered).indexOf(marker);
            if (index !== -1) return this.take(index + marker.length);
            if (this.buffered > limit) throw new Error("Response header is too large");
            if (!(await this.more())) throw new Error("Connection closed early");
        }
    }

    async rest(limit: number) {
        while (await this.more()) if (this.buffered > limit) throw new Error("Public response exceeds byte limit");
        if (this.buffered > limit) throw new Error("Public response exceeds byte limit");
        return this.take(this.buffered);
    }
}

const socksConnect = async (proxy: OutboundProxy, address: string, port: number, signal: AbortSignal) => {
    const socket = connectTcp({ host: proxy.host, port: proxy.port });
    const abort = () => socket.destroy(new Error("Public URL request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", abort));
    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    const reader = new SocketReader(socket);
    socket.write(Buffer.from([5, 1, 0]));
    const greeting = await reader.exactly(2);
    if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("The outbound proxy refused the connection");
    const host = (() => {
        if (isIP(address) === 4) return Buffer.from([1, ...address.split(".").map(Number)]);
        const [left, right] = new URL(`http://[${address}]`).hostname
            .slice(1, -1)
            .split("::")
            .map((part) => (part ? part.split(":") : []));
        const groups = [...left, ...Array(8 - left.length - (right?.length ?? 0)).fill("0"), ...(right ?? [])];
        return Buffer.concat([Buffer.from([4]), Buffer.from(groups.map((group) => group.padStart(4, "0")).join(""), "hex")]);
    })();
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(port);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), host, portBytes]));
    const reply = await reader.exactly(4);
    if (reply[1] !== 0) throw new Error(`The outbound proxy could not reach the host (code ${reply[1]})`);
    await reader.exactly(reply[3] === 1 ? 6 : reply[3] === 4 ? 18 : (await reader.exactly(1))[0] + 2);
    reader.detach();
    return socket;
};

const decodeChunked = (raw: Buffer, limit: number) => {
    const parts: Buffer[] = [];
    let offset = 0;
    let total = 0;
    for (;;) {
        const lineEnd = raw.indexOf("\r\n", offset);
        if (lineEnd === -1) throw new Error("Public response was interrupted");
        const size = Number.parseInt(raw.subarray(offset, lineEnd).toString("latin1").split(";")[0].trim(), 16);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid chunked response");
        offset = lineEnd + 2;
        if (size === 0) return Buffer.concat(parts, total);
        if (raw.length < offset + size + 2) throw new Error("Public response was interrupted");
        total += size;
        if (total > limit) throw new Error("Public response exceeds byte limit");
        parts.push(raw.subarray(offset, offset + size));
        offset += size + 2;
    }
};

export const socksTunnel = async (proxy: OutboundProxy, target: URL, address: string, signal: AbortSignal): Promise<Socket> => {
    const secure = target.protocol === "https:" || target.protocol === "wss:";
    const tunnel = await socksConnect(proxy, address, Number(target.port || (secure ? 443 : 80)), signal);
    if (!secure) return tunnel;
    const socket = connectTls({ socket: tunnel, servername: isIP(target.hostname.replace(/^\[|\]$/g, "")) ? undefined : target.hostname, ALPNProtocols: ["http/1.1"] });
    socket.once("close", () => tunnel.destroy());
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("secureConnect", resolve);
            socket.once("error", reject);
        });
    } catch (error) {
        socket.destroy();
        throw error;
    }
    return socket;
};

export const socksExchange = async (
    proxy: OutboundProxy,
    target: URL,
    address: string,
    method: string,
    headers: Record<string, string>,
    payload: Buffer | undefined,
    signal: AbortSignal,
    maxBytes: number,
    onHead?: () => void,
): Promise<RawExchange> => {
    const socket = await socksTunnel(proxy, target, address, signal);
    try {
        const reader = new SocketReader(socket);
        const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`, "Connection: close"];
        for (const [name, value] of Object.entries(headers)) if (!/[\r\n]/.test(name + value)) lines.push(`${name}: ${value}`);
        socket.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), payload ?? Buffer.alloc(0)]));
        const head = (await reader.until("\r\n\r\n", HEADER_LIMIT)).toString("latin1").split("\r\n");
        onHead?.();
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0])?.[1]);
        if (!status) throw new Error("Invalid public response");
        const responseHeaders = head
            .slice(1)
            .filter(Boolean)
            .map((line): [string, string] => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]);
        const header = (name: string) => responseHeaders.find(([key]) => key === name)?.[1];
        if (method === "HEAD" || [204, 205, 304].includes(status) || [301, 302, 303, 307, 308].includes(status)) return { status, headers: responseHeaders, body: null };
        const encoding = header("content-encoding");
        if (encoding && encoding !== "identity") throw new Error("Compressed public response is not supported");
        if (header("transfer-encoding")?.toLowerCase().includes("chunked"))
            return { status, headers: responseHeaders, body: decodeChunked(await reader.rest(maxBytes + HEADER_LIMIT), maxBytes) };
        const length = header("content-length");
        if (length !== undefined) {
            if (!/^\d+$/.test(length) || Number(length) > maxBytes) throw new Error("Public response exceeds byte limit");
            return { status, headers: responseHeaders, body: await reader.exactly(Number(length)).catch(() => Promise.reject(new Error("Public response was interrupted"))) };
        }
        return { status, headers: responseHeaders, body: await reader.rest(maxBytes) };
    } finally {
        socket.destroy();
    }
};
