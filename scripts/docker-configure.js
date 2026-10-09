const fs = require("node:fs");
const path = require("node:path");

const env = (name) => process.env[name]?.trim() || undefined;
const file = env("CONFIG_PATH");
const publicDomain = env("DOMAIN");
const protocol = publicDomain?.startsWith("http://") ? "http" : "https";
const domain = publicDomain?.replace(/^https?:\/\//, "").replace(/\/+$/, "");

if (!file) throw new Error("[configure] CONFIG_PATH is not set");
if (!domain) {
    console.error("[configure] DOMAIN is not set, put the public host name of the instance in .env");
    process.exit(1);
}

const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const section = (...keys) => keys.reduce((parent, key) => (parent[key] ??= {}), config);
const origin = `${protocol}://${domain}`;
const port = env("PORT") ?? "3001";

section("general").serverName = origin;
section("api").endpointPublic = `${origin}/api/v9`;
Object.assign(section("cdn"), {
    endpointPublic: `${origin}/`,
    endpointPrivate: `http://127.0.0.1:${port}/`,
});
section("gateway").endpointPublic = `${protocol === "http" ? "ws" : "wss"}://${domain}/`;
Object.assign(section("security"), {
    trustedProxies: env("TRUSTED_PROXIES") ?? "uniquelocal",
    forwardedFor: "X-Forwarded-For",
});

const regions = section("regions");
regions.default ??= "spacebar";
regions.available = regions.available?.length ? regions.available : [{ id: regions.default, name: regions.default, vip: false, custom: false, deprecated: false }];
for (const region of regions.available) if (region.id === regions.default) region.endpoint = `${domain}/voice`;

// INSTANCE_NAME names a new instance, and changing it in .env renames the instance on the next start. Otherwise the
// name set in the admin panel stays: the last value taken from .env is remembered next to the config file
const instanceName = env("INSTANCE_NAME");
const appliedNameFile = path.join(path.dirname(file), ".instance-name");
const appliedName = fs.existsSync(appliedNameFile) ? fs.readFileSync(appliedNameFile, "utf8") : null;
// before this was remembered, INSTANCE_NAME was applied on every start, so an existing config already carries it or a newer admin panel name
const firstRemembered = appliedName === null && !!config.general?.instanceName;
if (instanceName && instanceName !== appliedName && !firstRemembered) {
    section("general").instanceName = instanceName;
    section("client").instanceName = instanceName;
}

const cap = {
    instance: env("CAP_INSTANCE_URL"),
    sitekey: env("CAP_SITE_KEY"),
    secret: env("CAP_SECRET_KEY"),
};
if (cap.instance && cap.sitekey && cap.secret)
    Object.assign(section("security", "captcha"), {
        enabled: true,
        capMode: "standalone",
        ...cap,
    });
else if (cap.instance || cap.sitekey || cap.secret)
    console.warn("[configure] Cap needs CAP_INSTANCE_URL, CAP_SITE_KEY and CAP_SECRET_KEY together, leaving the captcha settings alone");

const smtpHost = env("SMTP_HOST");
if (smtpHost) {
    const secure = env("SMTP_SECURE") === "true";
    Object.assign(section("email"), {
        provider: "smtp",
        senderAddress: env("EMAIL_FROM") ?? `noreply@${domain}`,
    });
    Object.assign(section("email", "smtp"), {
        host: smtpHost,
        port: Number(env("SMTP_PORT") ?? (secure ? 465 : 587)),
        secure,
        starttls: !secure && env("SMTP_STARTTLS") !== "false",
        username: env("SMTP_USERNAME") ?? null,
        password: env("SMTP_PASSWORD") ?? null,
    });
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(config, null, 4), { mode: 0o600 });
if (instanceName && instanceName !== appliedName) fs.writeFileSync(appliedNameFile, instanceName);
console.log(`[configure] ${file} points at ${origin}`);
