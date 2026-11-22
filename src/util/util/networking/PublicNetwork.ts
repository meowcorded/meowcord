import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as requestHttp, IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { Config } from "../Config";
import type { Socket } from "node:net";
import { outboundProxy, RawExchange, socksExchange, socksTunnel } from "./SocksTransport";
import { PublicFetchError } from "./PublicFetchError";

export * from "./PublicFetchError";

const privateV4 = new BlockList();
const privateV6 = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
] as const)
    privateV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["::ffff:0:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
] as const)
    privateV6.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string) {
    const family = isIP(address);
    if (!family) return true;
    if (family === 4) return privateV4.check(address, "ipv4");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return mapped ? privateV4.check(mapped[1], "ipv4") : privateV6.check(address, "ipv6");
}

export async function isPublicUrl(url: string | URL, opts: { httpsOnly?: boolean } = {}) {
    if (!URL.canParse(url)) return false;
    const parsed = new URL(url);
    if (Config.get().security.allowPrivateNetworkRequests) return /^https?:$/.test(parsed.protocol);
    if (parsed.protocol !== "https:" && (opts.httpsOnly || parsed.protocol !== "http:")) return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
        ? [host]
        : await lookup(host, { all: true, verbatim: true }).then(
              (results) => results.map(({ address }) => address),
              () => [],
          );
    return addresses.length > 0 && !addresses.some(isPrivateAddress);
}

export interface PublicFetchLimits {
    maxBytes?: number;
    timeoutMs?: number;
    firstByteMs?: number;
    trustedCdnOrigin?: string;
    allowExternal?: boolean;
}

export function isTrustedCdnAsset(url: URL, origin?: string) {
    if (!origin || !URL.canParse(origin) || url.origin !== new URL(origin).origin || /%2f|%5c|%00/i.test(url.pathname)) return false;
    return /^\/(?:attachments\/\d+\/\d+\/[^/]+|(?:avatars|icons|banners|splashes|emojis|stickers)\/\d+\/(?:[^/]+)|(?:emojis|stickers)\/\d+(?:\.[a-z]+)?)$/.test(url.pathname);
}

async function resolveFetchAddress(url: URL, signal: AbortSignal, trustedCdnOrigin?: string) {
    signal.throwIfAborted();
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid public HTTP URL");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let abort = () => {};
    let addresses;
    try {
        addresses = isIP(hostname)
            ? [{ address: hostname, family: isIP(hostname) }]
            : await Promise.race([
                  lookup(hostname, { all: true, verbatim: true }),
                  new Promise<never>((_, reject) => {
                      abort = () => reject(new Error("Public URL request aborted"));
                      signal.addEventListener("abort", abort, { once: true });
                      if (signal.aborted) abort();
                  }),
              ]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
    signal.throwIfAborted();
    if (
        !addresses.length ||
        (!Config.get().security.allowPrivateNetworkRequests && !isTrustedCdnAsset(url, trustedCdnOrigin) && addresses.some(({ address }) => isPrivateAddress(address)))
    )
        throw new Error("Public URL resolves to a forbidden address");
    return addresses;
}

const FAMILY_MEMORY = 10 * 60 * 1000;
const workingFamily = new Map<string, { family: number; at: number }>();

export const orderAddresses = <T extends { family: number }>(hostname: string, addresses: T[], now = Date.now()) => {
    const known = workingFamily.get(hostname);
    const first = known && now - known.at < FAMILY_MEMORY && addresses.some((address) => address.family === known.family) ? known.family : addresses[0]?.family;
    const preferred = addresses.filter((address) => address.family === first);
    const other = addresses.filter((address) => address.family !== first);
    return Array.from({ length: Math.max(preferred.length, other.length) }, (_, i) => [preferred[i], other[i]])
        .flat()
        .filter((address): address is T => !!address);
};

export const rememberFamily = (hostname: string, family: number, now = Date.now()) => {
    if (workingFamily.size > 10_000) workingFamily.clear();
    workingFamily.set(hostname, { family, at: now });
};

const unreachable = (error: unknown) =>
    ["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "ETIMEDOUT"].includes((error as NodeJS.ErrnoException)?.code ?? "") ||
    /could not reach the host \(code [345]\)/.test(String(error));

export async function publicTunnel(url: URL, signal: AbortSignal): Promise<Socket | null> {
    const target = new URL(url.href);
    if (target.protocol === "ws:" || target.protocol === "wss:") target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    const addresses = await resolveFetchAddress(target, signal);
    const proxy = outboundProxy();
    for (const [index, { address }] of addresses.entries()) {
        if (isPrivateAddress(address) || proxy === "direct") return null;
        if (!proxy) throw new Error("PUBLIC_FETCH_PROXY is not set, so connections to other instances are refused");
        try {
            return await socksTunnel(proxy, url, address, signal);
        } catch (error) {
            if (index === addresses.length - 1 || signal.aborted || !unreachable(error)) throw error;
        }
    }
    throw new Error("Public URL has no reachable address");
}

async function readPublicResponse(response: IncomingMessage, maxBytes: number, method: string) {
    if (method === "HEAD" || [204, 205, 304].includes(response.statusCode ?? 0)) {
        response.destroy();
        return null;
    }
    if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") throw new Error("Compressed public response is not supported");
    const length = response.headers["content-length"];
    if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maxBytes)) throw new Error("Public response exceeds byte limit");
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of response) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new Error("Public response exceeds byte limit");
        parts.push(chunk);
    }
    if (!response.complete) throw new Error("Public response was interrupted");
    return Buffer.concat(parts);
}

type PublicFetch = (url: string, init: RequestInit, redirects: number, limits: PublicFetchLimits) => Promise<Response>;

let publicFetchOverride: PublicFetch | undefined;

export function usePublicFetch(next: PublicFetch) {
    publicFetchOverride = next;
}

export const hasPublicFetchOverride = () => !!publicFetchOverride;

export async function fetchPublicUrl(url: string, init: RequestInit = {}, redirects = 3, limits: PublicFetchLimits = {}): Promise<Response> {
    if (publicFetchOverride) return publicFetchOverride(url, init, redirects, limits);
    const maxBytes = limits.maxBytes ?? 5 * 1024 * 1024;
    const timeoutMs = limits.timeoutMs ?? 15000;
    const firstByteMs = limits.firstByteMs ?? timeoutMs;
    if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        maxBytes > 64 * 1024 * 1024 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 30000 ||
        !Number.isSafeInteger(firstByteMs) ||
        firstByteMs <= 0
    )
        throw new Error("Invalid public fetch limits");
    if (!Number.isSafeInteger(redirects) || redirects < 0 || redirects > 5) throw new Error("Invalid public redirect limit");
    if (init.body != null && typeof init.body !== "string" && !(init.body instanceof Uint8Array)) throw new Error("Unsupported public request body");
    const body = init.body == null ? undefined : Buffer.from(init.body);
    if (body && body.length > maxBytes) throw new Error("Public request exceeds byte limit");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Public URL request timed out")), timeoutMs);
    const firstByte = firstByteMs < timeoutMs ? setTimeout(() => controller.abort(new Error("Public URL sent no response in time")), firstByteMs) : undefined;
    const answered = () => clearTimeout(firstByte);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const proxy = outboundProxy();
    const exchangeDirect = (target: URL, address: { address: string; family: number }, method: string, outgoing: Record<string, string>, payload?: Buffer) =>
        new Promise<RawExchange>((resolve, reject) => {
            const request = (target.protocol === "https:" ? requestHttps : requestHttp)(
                target,
                {
                    method,
                    headers: outgoing,
                    agent: false,
                    family: address.family,
                    signal,
                    lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family),
                },
                (response) => {
                    answered();
                    const status = response.statusCode ?? 0;
                    const headers = Object.entries(response.headers).flatMap(([name, values]) =>
                        (Array.isArray(values) ? values : values === undefined ? [] : [values]).map((value): [string, string] => [name, value]),
                    );
                    if ([301, 302, 303, 307, 308].includes(status)) {
                        response.destroy();
                        return resolve({ status, headers, body: null });
                    }
                    readPublicResponse(response, maxBytes, method).then(
                        (body) => resolve({ status, headers, body }),
                        (error) => {
                            response.destroy();
                            reject(error);
                        },
                    );
                },
            );
            request.on("error", reject);
            request.end(payload);
        });
    const requestUrl = async (target: URL, remaining: number, method: string, headers: Headers, payload?: Buffer): Promise<Response> => {
        if (limits.allowExternal === false && !isTrustedCdnAsset(target, limits.trustedCdnOrigin)) throw new Error("External public requests are disabled");
        const addresses = await resolveFetchAddress(target, signal, limits.trustedCdnOrigin);
        const outgoing = Object.fromEntries(headers.entries());
        outgoing["accept-encoding"] = "identity";
        delete outgoing.host;
        delete outgoing.connection;
        delete outgoing["transfer-encoding"];
        delete outgoing["content-length"];
        if (payload) outgoing["content-length"] = String(payload.length);
        const exchange = await (async () => {
            const ordered = orderAddresses(target.hostname, addresses);
            for (const [index, address] of ordered.entries()) {
                const viaProxy = !isTrustedCdnAsset(target, limits.trustedCdnOrigin) && !isPrivateAddress(address.address) && proxy !== "direct";
                if (viaProxy && !proxy) throw new Error("PUBLIC_FETCH_PROXY is not set, so requests to user-chosen URLs are refused");
                try {
                    const result =
                        viaProxy && proxy
                            ? await socksExchange(proxy, target, address.address, method, outgoing, payload, signal, maxBytes, answered)
                            : await exchangeDirect(target, address, method, outgoing, payload);
                    rememberFamily(target.hostname, address.family);
                    return result;
                } catch (error) {
                    if (index === ordered.length - 1 || signal.aborted || !unreachable(error)) throw error;
                }
            }
            throw new Error("Public URL has no reachable address");
        })();
        const location = exchange.headers.find(([name]) => name === "location")?.[1];
        if ([301, 302, 303, 307, 308].includes(exchange.status) && location && init.redirect !== "manual") {
            if (init.redirect === "error") throw new Error("Public redirect refused");
            if (!remaining) throw new Error("Too many public redirects");
            if (!URL.canParse(location, target)) throw new Error("Invalid public redirect");
            const next = new URL(location, target);
            const nextHeaders = new Headers(headers);
            if (next.origin !== target.origin)
                for (const name of ["authorization", "proxy-authorization", "cookie", "cookie2", "x-api-key", "x-auth-token", "x-access-token", "signature", "referer", "origin"])
                    nextHeaders.delete(name);
            const nextMethod = (exchange.status === 303 && method !== "HEAD") || ([301, 302].includes(exchange.status) && method === "POST") ? "GET" : method;
            if (nextMethod !== method) for (const name of ["content-type", "content-length", "content-encoding"]) nextHeaders.delete(name);
            return requestUrl(next, remaining - 1, nextMethod, nextHeaders, nextMethod === method ? payload : undefined);
        }
        const responseHeaders = new Headers();
        for (const [name, value] of exchange.headers) responseHeaders.append(name, value);
        const result = new Response(exchange.body, { status: exchange.status, headers: responseHeaders });
        Object.defineProperties(result, {
            url: { value: target.href },
            redirected: { value: target.href !== new URL(url).href },
        });
        return result;
    };
    let stop = () => {};
    const deadline = new Promise<never>((_, reject) => {
        stop = () => controller.signal.removeEventListener("abort", expire);
        const expire = () => reject(new PublicFetchError("timeout", `${new URL(url).host} didn't answer within ${Math.round(timeoutMs / 1000)} seconds`));
        controller.signal.addEventListener("abort", expire, { once: true });
    });
    try {
        return await Promise.race([requestUrl(new URL(url), redirects, (init.method ?? "GET").toUpperCase(), new Headers(init.headers), body), deadline]);
    } catch (error) {
        if (controller.signal.aborted && !init.signal?.aborted && !(error instanceof PublicFetchError))
            throw new PublicFetchError("timeout", `${new URL(url).host} didn't answer within ${Math.round(timeoutMs / 1000)} seconds`, error);
        throw error;
    } finally {
        stop();
        clearTimeout(timer);
        answered();
    }
}
