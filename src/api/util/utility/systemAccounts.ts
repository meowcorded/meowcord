import { lockTransaction } from "@spacebar/database/Sql";
import { Channel, getDatabase, Message, Recipient, User, UserSettings } from "@spacebar/database";
import { Config, Rights, Snowflake, uploadMessageFiles } from "@spacebar/util";
import { ChannelType, Embed, Reaction, UserFlags } from "@spacebar/schemas";
import { MessageOptionAttachment } from "@spacebar/util/dtos/MessageOptions";
import { sendMessage } from "../handlers/Message";
import { encryptSystemFiles, encryptSystemPayload, EncryptedSystemFile, SystemCardEmbed } from "./systemEncryption";
import { E2EE_FALLBACK_CONTENT } from "./e2ee";
import { systemEmbedText } from "./safetyMessageText";
import { reopenDirectMessage } from "../handlers/DirectMessage";

// Two accounts the server speaks through. "official" is a real system account (clients show it as OFFICIAL and
// its dms are read-only); "appeals" is a verified bot, because clients don't allow reactions in system dms and
// staff vote on appeals with reactions. Both are marked with the SYSTEM user flag (private flags only), which nothing
// else sets, so a regular user can never be mistaken for one. They're found by that flag, not by fields an admin can edit.
const SYSTEM_MARKER = Number(UserFlags.FLAGS.SYSTEM);
const ACCOUNTS = {
    official: {
        username: "official",
        name: () => Config.get().general.instanceName,
        system: true,
        bot: false,
    },
    appeals: {
        username: "appeals",
        name: () => `${Config.get().general.instanceName} Appeals`,
        system: false,
        bot: true,
    },
} as const;
export type SystemAccountKind = keyof typeof ACCOUNTS;

// just enough to post (sending, reacting) and to dm everyone at once for announcements
const SYSTEM_RIGHTS = (Rights.FLAGS.SEND_MESSAGES | Rights.FLAGS.SELF_ADD_REACTIONS | Rights.FLAGS.BYPASS_RATE_LIMITS).toString();

const cachedIds: Partial<Record<SystemAccountKind, string>> = {};

const accountFlights = new Map<SystemAccountKind, Promise<User>>();
export async function getSystemAccount(kind: SystemAccountKind): Promise<User> {
    let flight = accountFlights.get(kind);
    if (!flight) {
        flight = loadSystemAccount(kind).finally(() => accountFlights.delete(kind));
        accountFlights.set(kind, flight);
    }
    return flight;
}
async function loadSystemAccount(kind: SystemAccountKind): Promise<User> {
    const database = getDatabase();
    if (!database) throw new Error("Database unavailable");
    return database.transaction(async (manager) => {
        await lockTransaction(manager, `system-account:${kind}`);
        const users = manager.getRepository(User);
        const settingsRepository = manager.getRepository(UserSettings);
        const spec = ACCOUNTS[kind];
        const cached = cachedIds[kind] ? await users.findOne({ where: { id: cachedIds[kind] } }) : null;
        // the oldest one wins, so an instance that ended up with copies keeps using the same account
        const found =
            (cached && cached.username === spec.username && cached.bot === spec.bot && (Number(cached.flags) & SYSTEM_MARKER) !== 0 ? cached : null) ??
            (
                await users.find({
                    where: { username: spec.username, bot: spec.bot },
                    order: { created_at: "ASC" },
                })
            ).find((u) => (Number(u.flags) & SYSTEM_MARKER) !== 0);

        let user = found;
        if (!user) {
            const settings = UserSettings.create({ locale: "en-US" });
            user = User.create({
                id: Snowflake.generate(),
                username: spec.username,
                discriminator: "0",
                global_name: spec.name(),
                system: spec.system,
                bot: spec.bot,
                verified: true,
                flags: SYSTEM_MARKER,
                public_flags: spec.bot ? Number(UserFlags.FLAGS.VERIFIED_BOT) : 0,
                rights: SYSTEM_RIGHTS,
                premium: false,
                premium_type: 0,
                // no password and no email, so nobody can log in as it
                data: { hash: undefined, valid_tokens_since: new Date() },
                settings,
                created_at: new Date(),
            });
            await settingsRepository.save(settings);
            await users.save(user);
            console.log(`[System] Created the ${kind} account (${user.id})`);
        } else {
            // follow the instance name when it changes, and put back anything else that drifted: older accounts had the
            // 0000 discriminator, and admin panel edits used to clear `system` and save the default premium onto them
            const expected = {
                global_name: spec.name(),
                rights: SYSTEM_RIGHTS,
                discriminator: "0",
                system: spec.system,
                premium: false,
                premium_type: 0,
                premium_since: null as unknown as Date,
            };
            const drifted = (Object.keys(expected) as (keyof typeof expected)[]).filter((key) => String(user![key] ?? null) !== String(expected[key] ?? null));
            if (drifted.length) {
                Object.assign(user, expected);
                await users.update({ id: user.id }, expected);
                if (cachedIds[kind] !== user.id) console.log(`[System] Repaired the ${kind} account (${user.id}): ${drifted.join(", ")}`);
            }
        }
        cachedIds[kind] = user.id;
        return user;
    });
}

export const isSystemAccount = async (user_id: string) =>
    (await Promise.all((Object.keys(ACCOUNTS) as SystemAccountKind[]).map((k) => getSystemAccount(k)))).some((u) => u.id === user_id);

type SystemDMFile = Parameters<typeof uploadMessageFiles>[1][number];

const SAFETY_CARD_TYPES = ["safety_system_notification", "safety_policy_notice"];
const isSafetyCard = (embed: Embed) => SAFETY_CARD_TYPES.includes(String(embed.type));

export interface SystemDMMessage {
    content?: string;
    embeds?: Embed[];
    reactions?: Reaction[];
    files?: SystemDMFile[];
    encryptedFiles?: EncryptedSystemFile[];
    id?: string;
}
export async function sendSystemDM(kind: SystemAccountKind, recipientId: string, message: SystemDMMessage) {
    return sendEncryptedSystemDM(await getSystemAccount(kind), recipientId, message);
}
export async function sendEncryptedSystemDM(sender: User, recipientId: string, message: SystemDMMessage) {
    const id = message.id ?? Snowflake.generate();
    const existing = await Message.findOne({ where: { id } });
    if (existing) {
        if (existing.author_id !== sender.id) throw new Error("System message id collision");
        return existing;
    }
    const database = getDatabase();
    if (!database) throw new Error("Database unavailable");
    const [found] = await database.query(
        `SELECT r.channel_id FROM recipients r JOIN channels c ON c.id=r.channel_id
        WHERE r.user_id=$1 AND c.type=$3 AND EXISTS (SELECT 1 FROM recipients other WHERE other.channel_id=r.channel_id AND other.user_id=$2)
        AND NOT EXISTS (SELECT 1 FROM recipients extra WHERE extra.channel_id=r.channel_id AND extra.user_id NOT IN ($1,$2)) LIMIT 1`,
        [recipientId, sender.id, ChannelType.DM],
    );
    const channel = found
        ? await Channel.findOneOrFail({
              where: { id: found.channel_id },
              relations: { recipients: true },
          })
        : await Channel.create({
              type: ChannelType.DM,
              created_at: new Date(),
              e2ee_enabled_at: new Date(),
              nsfw: false,
              recipients: [sender.id, recipientId].map((user_id) => Recipient.create({ user_id, closed: true })),
          }).save();
    await Channel.ensureDefaultPrivateEncryption(channel, sender.id);
    const files = message.encryptedFiles ?? encryptSystemFiles(message.files ?? []);
    const text = [message.content, ...(message.embeds ?? []).flatMap(systemEmbedText)].filter(Boolean).join("\n\n");
    const cards = (message.embeds ?? []).filter(isSafetyCard).map((embed) => ({
        type: String(embed.type) as SystemCardEmbed["type"],
        fields: (embed.fields ?? []).map((field) => ({ name: field.name, value: field.value })),
    }));
    const encrypted = await encryptSystemPayload(sender, [recipientId], channel.id, id, {
        content: text,
        ...(files.length ? { attachments: files.map((file) => file.meta) } : {}),
        ...(cards.length ? { embeds: cards } : {}),
    });
    await reopenDirectMessage(channel, sender.id, { neverMessageRequest: true });
    const attachments = files.length ? await uploadMessageFiles<MessageOptionAttachment>(`/attachments/${channel.id}/${id}`, files) : undefined;
    return sendMessage({
        id,
        nonce: id,
        channel_id: channel.id,
        author_id: sender.id,
        content: E2EE_FALLBACK_CONTENT,
        embeds: [],
        encrypted,
        reactions: message.reactions,
        attachments,
    });
}
