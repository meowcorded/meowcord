const TAG = 8;
const SELECT = 5;
const PLURAL = 6;

// fosscord too: client files downloaded before branding moved into this plugin already had Discord rewritten to Fosscord
const CANDIDATE = /discord|discrod|fosscord|nitr|premium|ディスコード|ไนโตร/i;

const brandText = (text: string, name: string) => {
    if (!CANDIDATE.test(text)) return text;
    const host = location.host;
    return text
        .replace(/https?:\/\/discord\.gg\//g, () => `${location.origin}/invite/`)
        .replace(/(?<![\w@.-])discord\.gg\//g, () => `${host}/invite/`)
        .replace(/https?:\/\/(?:www\.)?discord\.com(?![\w.-])/g, () => location.origin)
        .replace(/(?<![\w@./-])discord\.com(?![\w.-])/g, () => host)
        .replace(/DISCORD/g, (match) => (/741741/.test(text) ? match : name.toUpperCase()))
        .replace(/FOSSCORD/g, () => name.toUpperCase())
        .replace(/Discord|Discrod|Fosscord|ディスコード/g, () => name)
        .replace(/(?<![\p{L}\w.@/-])discord(?![\p{L}\w.@/-])/gu, () => name)
        .replace(/(?:NITRO|PREMIUM)(?: BASIC| CLASSIC)?/g, "FEATURES")
        .replace(/ไนโตร/g, "Features")
        .replace(/Nitro(['’])(\p{Script=Latin}+)/gu, "Features")
        .replace(/Nitr([oóо])(\p{Script=Latin}*)/gu, "Features")
        .replace(/Nitr(?:a|u+|em|om|e|y|ou)(?!\p{Script=Latin})/gu, "Features")
        .replace(/\bPremium(?: Basic| Classic)?\b/gi, "Features");
};

const QR_LOGIN = /^\["Scan this with the ",\[8,"\$b",\["[^"]*"\]\]," to log in instantly\."\]$/;

const QR_LABEL = JSON.stringify(["QR code to log in with the Discord mobile app"]);

const brandList = (list: unknown[], name: string): unknown[] =>
    list.map((node) => (typeof node === "string" ? brandText(node, name) : Array.isArray(node) ? brandNode(node, name) : node));

const brandOptions = (options: Record<string, unknown>, name: string) =>
    Object.fromEntries(Object.entries(options).map(([key, value]) => [key, Array.isArray(value) ? brandList(value, name) : value]));

const brandNode = (node: unknown[], name: string): unknown[] => {
    const [type] = node;
    if (type === TAG && Array.isArray(node[2])) return [...node.slice(0, 2), brandList(node[2], name), ...node.slice(3)];
    if ((type === SELECT || type === PLURAL) && node[2] && typeof node[2] === "object")
        return [...node.slice(0, 2), brandOptions(node[2] as Record<string, unknown>, name), ...node.slice(3)];
    return node;
};

const helpConfigured = () => {
    const url = (window as any).GLOBAL_ENV?.HELP_URL;
    return typeof url === "string" && /^https?:\/\//.test(url);
};

// Messages that end in "... here: <help article link>". Without a help center the link is removed, which would leave
// the sentence hanging, so these are reworded instead.
const NO_HELP_LINK: [RegExp, string][] = [
    [
        /^Your message could not be delivered\.\n\nYou can see the full list of reasons here: $/,
        "Your message could not be delivered.\n\nThis usually means you don't share a server with them, or they only accept direct messages from friends.",
    ],
    [
        /^(Your message could not be delivered\. Send a friend request first and start the conversation once they.ve accepted\.)\n\nHere is the full list of reasons why your message could not be delivered: $/,
        "$1",
    ],
    [/^(Your message could not be delivered because this message contains a link blocked by Discord)\. You can learn more here: $/, "$1"],
];

const withoutHelpLink = (list: unknown[]): unknown[] => {
    const at = list.findIndex((node) => Array.isArray(node) && node[0] === 1 && node[1] === "helpUrl");
    const before = list[at - 1];
    if (at < 1 || typeof before !== "string") return list;
    for (const [pattern, text] of NO_HELP_LINK) if (pattern.test(before)) return [...list.slice(0, at - 1), before.replace(pattern, text), ...list.slice(at + 1)];
    return list;
};

export const brandMessages = (messages: Record<string, unknown>) => {
    if (!messages || typeof messages !== "object" || Array.isArray(messages)) return messages;
    const name = String((window as any).GLOBAL_ENV?.INSTANCE_NAME || "Fosscord");
    const qrLabel = JSON.stringify(messages["SzYj9v"]);
    const noHelp = !helpConfigured();
    for (const key in messages) {
        const value = messages[key];
        if (typeof value === "string") messages[key] = brandText(value, name);
        else if (Array.isArray(value)) messages[key] = brandList(noHelp ? withoutHelpLink(value) : value, name);
    }
    const qr = messages["Qq+A6i"];
    if (Array.isArray(qr) && QR_LOGIN.test(JSON.stringify(qr)))
        messages["Qq+A6i"] = ["Scan this with ", [8, "$b", ["your phone's camera"]], ", then approve the login on your phone."];
    if (qrLabel === QR_LABEL) messages["SzYj9v"] = ["QR code to log in with your phone's camera"];
    return messages;
};
