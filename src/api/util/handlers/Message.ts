import { sqlArrayIncludes } from "@spacebar/database/Sql";
import { HTTPError } from "lambert-server/HTTPError";
import { In, Raw } from "typeorm";
// noinspection ES6PreferShortImport -- Causes a circular reference...
import { fillMessageUrlEmbeds } from "../utility/EmbedHandlers";
import { resolveSoundmoji } from "../utility/Soundboard";
import { getDatabase, Application, Attachment, Channel, CloudAttachment, Guild, Member, Message, ReadState, Role, Sticker, User, Webhook } from "@spacebar/database";
import { Stopwatch, Random, normalizeLineEndings } from "@spacebar/extensions";
import {
    Config,
    DiscordApiErrors,
    emitEvent,
    ErrorList,
    EVERYONE_MENTION,
    FieldError,
    FieldErrors,
    fetchPublicUrl,
    getPermission,
    handleFile,
    HERE_MENTION,
    makeObjectErrorContent,
    MessageCreateEvent,
    MessageFlags,
    MessageUpdateEvent,
    Permissions,
    Rights,
    ROLE_MENTION,
    Snowflake,
    TraceNode,
    TraceRoot,
    TraceSubTree,
    USER_MENTION,
} from "@spacebar/util";
import {
    ActionRowComponent,
    AllowedMentions,
    AttachmentFlags,
    BaseMessageComponents,
    ButtonStyle,
    ChannelType,
    EmbedType,
    MessageComponentType,
    MessageCreateCloudAttachment,
    MessageReferenceType,
    MessageType,
    ReadStateType,
    UnfurledMediaItem,
    v1CompTypes,
} from "@spacebar/schemas";
import { scheduleSavedPoll } from "../utility/polls";
import { assertMessageSlowmode } from "./Slowmode";
import { downloadRemoteMedia } from "../utility/remoteMedia";
import { applyE2eeToMessage } from "../utility/e2ee";
import { getMentionedUsers } from "../utility/notifications";
import { MessageOptionAttachment, MessageOptions } from "@spacebar/util/dtos/MessageOptions";

import { COMPONENTS_V2, componentMessageErrors, messageComponentErrors, messageComponentText } from "./ComponentValidation";

const allow_empty = false;
// TODO: check webhook, application, system author, stickers
// TODO: embed gifs/videos/images

function checkActionRow(row: ActionRowComponent, knownComponentIds: string[], errors: Record<string, { code?: string; message: string }>, rowIndex: number) {
    if (!row.components) {
        return;
    }

    if (row.components.length < 1 || row.components.length > 5) {
        errors[`data.components[${rowIndex}].components`] = {
            code: "BASE_TYPE_BAD_LENGTH",
            message: `Must be between 1 and 5 in length.`,
        };
    }

    for (const component of row.components) {
        if (component.type == MessageComponentType.Button && component.style != ButtonStyle.Link) {
            if (component.custom_id?.trim() === "") {
                errors[`data.components[${rowIndex}].components[${row.components.indexOf(component)}].custom_id`] = {
                    code: "BUTTON_COMPONENT_CUSTOM_ID_REQUIRED",
                    message: "A custom id required",
                };
            }

            if (knownComponentIds.includes(component.custom_id!)) {
                errors[`data.components[${rowIndex}].components[${row.components.indexOf(component)}].custom_id`] = {
                    code: "COMPONENT_CUSTOM_ID_DUPLICATED",
                    message: "Component custom id cannot be duplicated",
                };
            } else {
                knownComponentIds.push(component.custom_id!);
            }
        }
    }
}
async function processMedia(media: UnfurledMediaItem, messageId: string, batchId: string, user: User, channel: Channel, id: string): Promise<(() => Promise<void>) | void> {
    if (Object.keys(media).length > 1) throw new HTTPError("Extra keys for media items are not allowed");
    if (!URL.canParse(media.url)) throw new HTTPError("media URL must be a URI");
    const url = new URL(media.url);
    if (!["http:", "https:", "attachment:"].includes(url.protocol)) throw new HTTPError("invalid media protocol");
    let attEnt: CloudAttachment;
    let delWhenDone = false;
    const cleanup = async () => {
        if (!delWhenDone) return;
        try {
            const deletion = await fetch(`${Config.get().cdn.endpointPrivate?.replace(/\/+$/, "")}/attachments/${attEnt.uploadFilename}`, {
                headers: { signature: Config.get().security.requestSignature || "" },
                method: "DELETE",
                signal: AbortSignal.timeout(15000),
            });
            await deletion.body?.cancel();
        } finally {
            await attEnt.remove();
        }
    };
    try {
        if (url.protocol === "attachment:") {
            const filename = decodeURIComponent(`${url.hostname}${url.pathname}`);
            const owner = { userId: user.id, channelId: channel.id };
            attEnt = await CloudAttachment.findOneOrFail({
                where: [
                    { ...owner, uploadFilename: filename },
                    { ...owner, userFilename: filename },
                ],
            });
        } else {
            const limits = Config.get();
            const ceiling = Math.min(
                limits.cdn.maxAttachmentSize,
                limits.limits.message.maxAttachmentSize,
                limits.limits.message.maxEmbedDownloadSize > 0 ? limits.limits.message.maxEmbedDownloadSize : 5 * 1024 * 1024,
            );
            let blob: Blob;
            try {
                blob = await downloadRemoteMedia(url, ceiling);
            } catch {
                throw new HTTPError("Remote media must be public, respond promptly and fit the attachment download limit", 400);
            }
            const segment = url.pathname.split("/").findLast((part) => part) || id;
            const safeName = segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255);
            const name = /^\.*$/.test(safeName) ? id : safeName;
            const uploadFilename = `${channel.id}/${batchId}/${id ?? "0"}/${name}`;
            attEnt = CloudAttachment.create({
                user: user,
                channel: channel,
                uploadFilename: uploadFilename,
                userAttachmentId: id ?? "0",
                userFilename: name,
                userFileSize: blob.size,
                userIsClip: false,
            });
            await attEnt.save();
            delWhenDone = true;
            const cdnUrl = Config.get().cdn.endpointPublic?.replace(/\/+$/, "");
            const fetchUrl = `${cdnUrl}/attachments/${attEnt.uploadFilename}`;
            const upload = await fetch(fetchUrl, {
                method: "PUT",
                body: blob,
                signal: AbortSignal.timeout(15000),
            });
            await upload.body?.cancel();
            if (!upload.ok) throw new HTTPError("Failed to upload remote media", 500);
            // re-fetch due to changed DB entry
            attEnt = await CloudAttachment.findOneOrFail({
                where: {
                    id: attEnt.id,
                },
            });
        }

        const cloneResponse = await fetch(
            `${Config.get().cdn.endpointPrivate?.replace(/\/+$/, "")}/attachments/${attEnt.uploadFilename}/clone_to_message/${messageId}?channel_id=${channel.id}`,
            {
                method: "POST",
                signal: AbortSignal.timeout(15000),
                headers: {
                    signature: Config.get().security.requestSignature || "",
                },
            },
        );

        if (!cloneResponse.ok) {
            console.error(`[Message] Failed to clone attachment ${attEnt.userFilename} to message ${messageId}`);
            throw new HTTPError("Failed to process attachment: " + (await cloneResponse.text()), 500);
        }

        const cloneRespBody = (await cloneResponse.json()) as { success: boolean; new_path: string };
        media.proxy_url = `${Config.get().cdn.endpointPublic?.replace(/\/+$/, "")}/${cloneRespBody.new_path}`;
        if (url.protocol === "attachment:") media.url = media.proxy_url;

        const realAtt = Attachment.create({
            filename: attEnt.userFilename,
            size: attEnt.size,
            height: attEnt.height,
            width: attEnt.width,
            content_type: attEnt.contentType || attEnt.userOriginalContentType,
            channel_id: channel.id,
            message_id: messageId,
        });
        await realAtt.save();

        //TODO maybe this needs to be a new DB object? I don't see a reason to do this rn though, though this id *should* technically be different from the id of the attachment
        media.id = realAtt.id;

        media.height = attEnt.height;
        media.width = attEnt.width;
        media.content_type = attEnt.contentType;
        //TODO flags?
        media.attachment_id = attEnt.id;
        //TODO preview stuff

        if (delWhenDone) return cleanup;
    } catch (error) {
        await cleanup().catch(() => {});
        throw error;
    }
}

export function assignComponentIds(components: unknown[]) {
    type Node = { id?: number; components?: Node[]; accessory?: Node; component?: Node };
    const walk = (nodes: Node[], visit: (node: Node) => void) => {
        for (const node of nodes) {
            if (!node || typeof node !== "object") continue;
            visit(node);
            walk([...(Array.isArray(node.components) ? node.components : []), ...(node.accessory ? [node.accessory] : []), ...(node.component ? [node.component] : [])], visit);
        }
    };
    const used = new Set<number>();
    walk(components as Node[], (node) => {
        if (typeof node.id === "number" && node.id !== 0) used.add(node.id);
    });
    let next = 0;
    walk(components as Node[], (node) => {
        if (typeof node.id === "number" && node.id !== 0) return;
        do next++;
        while (used.has(next));
        node.id = next;
    });
    return components;
}
export function handleComps(components: BaseMessageComponents[], flags: number) {
    const validationErrors = messageComponentErrors(components, flags);
    if (Object.keys(validationErrors).length) throw FieldErrors(validationErrors);
    const conf = Config.get();
    const mediaGalleryLimit = conf.components.mediaGalleryLimit ?? 10;
    const actionRowLimit = conf.components.actionRowLimit ?? 5;

    const errors: Record<string, { code?: string; message: string }> = {};
    const knownComponentIds: string[] = [];
    const compv2 = (flags || 0) & Number(MessageFlags.FLAGS.IS_COMPONENTS_V2);
    if (!compv2) {
        const bad = components.reduce((bad, comp) => bad || !v1CompTypes.has(comp.type), false);
        if (bad) throw new HTTPError("Must be comp v2");
        if (components.length > actionRowLimit)
            throw FieldErrors({
                components: {
                    code: "BASE_TYPE_MAX_LENGTH",
                    message: `Must be ${actionRowLimit} or fewer in length.`,
                },
            });
    }
    type Node = { components?: Node[]; accessory?: Node };
    const count = (nodes: Node[]): number => nodes.reduce((sum, node) => sum + 1 + (Array.isArray(node.components) ? count(node.components) : 0) + (node.accessory ? 1 : 0), 0);
    if (count(components as Node[]) > 40)
        throw FieldErrors({
            components: {
                code: "BASE_TYPE_MAX_LENGTH",
                message: "Must be 40 or fewer in total components.",
            },
        });
    const medias: UnfurledMediaItem[] = [];
    for (const comp of components || []) {
        if (comp.type === MessageComponentType.ActionRow) {
            checkActionRow(comp, knownComponentIds, errors, components!.indexOf(comp));
        } else if (comp.type === MessageComponentType.Section) {
            const accessory = comp.accessory;
            if (comp.components.length < 1 || comp.components.length > actionRowLimit) {
                errors[`data.components[${components!.indexOf(comp)}].components`] = {
                    code: "TOO_LONG",
                    message: "Component list is too long",
                };
            }
            if (accessory.type === MessageComponentType.Thumbnail) {
                medias.push(accessory.media);
            }
        } else if (comp.type === MessageComponentType.TextDisplay) {
            //Here to make sure everything is checked
        } else if (comp.type === MessageComponentType.MediaGallery) {
            if (comp.items.length < 1 || comp.items.length > mediaGalleryLimit) {
                errors[`data.components[${components!.indexOf(comp)}].items`] = {
                    code: "TOO_LONG",
                    message: "Media list is too long",
                };
            }
            medias.push(...comp.items.map(({ media }) => media));
        } else if (comp.type === MessageComponentType.File) {
            medias.push(comp.file);
        } else if (comp.type === MessageComponentType.Separator) {
            //Here to make sure everything is checked
        } else if (comp.type === MessageComponentType.Container) {
            for (const elm of comp.components) {
                switch (elm.type) {
                    case MessageComponentType.Separator:
                    case MessageComponentType.TextDisplay:
                        break;
                    case MessageComponentType.Section: {
                        const accessory = elm.accessory;
                        if (elm.components.length < 1 || elm.components.length > actionRowLimit) {
                            errors[`data.components[${components!.indexOf(comp)}].components[${comp.components!.indexOf(elm)}].components`] = {
                                code: "TOO_LONG",
                                message: "Component list is too long",
                            };
                        }
                        if (accessory.type === MessageComponentType.Thumbnail) {
                            medias.push(accessory.media);
                        }
                        break;
                    }
                    case MessageComponentType.MediaGallery:
                        if (elm.items.length < 1 || elm.items.length > mediaGalleryLimit) {
                            errors[`data.components[${components!.indexOf(comp)}].components[${comp.components!.indexOf(elm)}].items`] = {
                                code: "TOO_LONG",
                                message: "Media list is too long",
                            };
                        }
                        medias.push(...elm.items.map(({ media }) => media));
                        break;
                    case MessageComponentType.File: {
                        medias.push(elm.file);
                        break;
                    }
                    case MessageComponentType.ActionRow:
                        checkActionRow(elm, knownComponentIds, errors, components!.indexOf(elm));
                        break;
                    default:
                        elm satisfies never;
                }
            }
        } else {
            comp satisfies never;
        }
    }

    if (medias.length > Config.get().limits.message.maxAttachments)
        errors.components = {
            code: "BASE_TYPE_MAX_LENGTH",
            message: `Must use ${Config.get().limits.message.maxAttachments} or fewer media attachments.`,
        };
    if (Object.keys(errors).length > 0) {
        throw FieldErrors(errors);
    }
    assignComponentIds(components);
    return async (messageId: string, user: User, channel: Channel) => {
        const batchId = `CLOUD_compUploads_${Random.getString("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 128)}`;
        const cleanups: (() => void | Promise<void>)[] = [];
        const pending = medias.entries();
        let stopped = false;
        const results = await Promise.allSettled(
            Array.from({ length: Math.min(4, medias.length) }, async () => {
                for (const [index, media] of pending) {
                    if (stopped) return;
                    try {
                        const cleanup = await processMedia(media, messageId, batchId, user, channel, String(index));
                        if (cleanup) cleanups.push(cleanup);
                    } catch (error) {
                        stopped = true;
                        throw error;
                    }
                }
            }),
        );
        await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
    };
}
export function resolveMessageComponentAttachments(components: unknown, attachments: Attachment[]) {
    const visit = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        const record = node as Record<string, unknown>;
        for (const key of ["media", "file"]) {
            const media = record[key] as UnfurledMediaItem | undefined;
            if (!media?.url?.startsWith("attachment://")) continue;
            const filename = decodeURIComponent(media.url.slice("attachment://".length));
            const attachment = attachments.find((item) => item.filename === filename);
            if (!attachment)
                throw FieldErrors({
                    components: {
                        code: "COMPONENT_ATTACHMENT_NOT_FOUND",
                        message: "Component media must reference an attachment on this message.",
                    },
                });
            const json = Attachment.prototype.toJSON.call(attachment);
            Object.assign(media, {
                id: attachment.id,
                url: json.url,
                proxy_url: json.proxy_url,
                width: attachment.width ?? undefined,
                height: attachment.height ?? undefined,
                content_type: attachment.content_type ?? undefined,
                attachment_id: attachment.id,
            });
            if (key === "file") Object.assign(record, { name: attachment.filename, size: attachment.size });
        }
        for (const key of ["components", "accessory", "items"]) visit(record[key]);
    };
    visit(components);
}

function checkMessageLimits(opts: MessageOptions) {
    const componentErrors = componentMessageErrors(opts);
    if (Object.keys(componentErrors).length) throw FieldErrors(componentErrors);
    const { maxCharacters, maxEmbeds, maxEmbedCharacters } = Config.get().limits.message;
    const errors: Record<string, { code: string; message: string }> = {};
    if (opts.content && opts.content.length > maxCharacters)
        errors.content = {
            code: "BASE_TYPE_MAX_LENGTH",
            message: `Must be ${maxCharacters} or fewer in length.`,
        };
    const embeds = opts.embeds ?? [];
    if (embeds.length > maxEmbeds)
        errors.embeds = {
            code: "BASE_TYPE_MAX_LENGTH",
            message: `Must be ${maxEmbeds} or fewer in length.`,
        };
    else {
        const length = (value: unknown) => (typeof value === "string" ? value.length : 0);
        const total = embeds.reduce(
            (sum, embed) =>
                sum +
                length(embed.title) +
                length(embed.description) +
                length(embed.footer?.text) +
                length(embed.author?.name) +
                (embed.fields ?? []).reduce((fields, field) => fields + length(field.name) + length(field.value), 0),
            0,
        );
        if (total > maxEmbedCharacters)
            errors.embeds = {
                code: "MAX_EMBED_SIZE_EXCEEDED",
                message: `Embed size exceeds maximum size of ${maxEmbedCharacters}`,
            };
    }
    if (Object.keys(errors).length) throw FieldErrors(errors);
}

export async function handleMessage(
    opts: MessageOptions,
    known: {
        channel?: Channel;
        permission?: Permissions;
        deferChannelUpdates?: boolean;
        componentsChanged?: boolean;
    } = {},
): Promise<Message> {
    const conf = Config.get();
    if (opts.content !== undefined) opts.content = normalizeLineEndings(opts.content);
    checkMessageLimits(opts);
    if (opts.components && known.componentsChanged !== false) handleComps(opts.components, opts.flags || 0);

    const channel =
        known.channel?.recipients && known.channel.id === opts.channel_id
            ? known.channel
            : await Channel.findOneOrFail({
                  where: { id: opts.channel_id },
                  relations: { recipients: true },
              });
    if (!channel || !opts.channel_id) throw new HTTPError("Channel not found", 404);

    const authorPermission = opts.author_id && !opts.webhook_id && !opts.interaction_metadata ? known.permission : undefined;
    let permission: null | Permissions = null;
    const limit = channel.rate_limit_per_user;
    const isEdit = !!opts.edited_timestamp;

    if (limit && !isEdit && !opts.webhook_id && !opts.interaction_metadata && opts.author_id) {
        permission = authorPermission ?? (await getPermission(opts.author_id, channel.guild_id, channel));
        await assertMessageSlowmode(channel, opts.author_id, permission);
    }

    const stickers = opts.sticker_ids ? await Sticker.find({ where: { id: In(opts.sticker_ids) } }) : undefined;

    const message = Message.create({
        ...opts,
        message_reference: opts.message_reference ?? undefined,
        poll: opts.poll,
        sticker_items: stickers,
        guild_id: channel.guild_id,
        channel_id: opts.channel_id,
        attachments: [],
        embeds: opts.embeds || [],
        reactions: opts.reactions || [],
        type: opts.type ?? 0,
        mentions: [],
        components: opts.components ?? undefined, // Fix Discord-Go?
    });
    message.channel = channel;
    await processMessageOptionAttachments(opts, message);
    await applyE2eeToMessage(opts, channel, message);

    if (opts.author_id) {
        message.author = await User.findOneOrFail({
            where: { id: opts.author_id },
        });
        const rights = new Rights(message.author.rights);
        message.author.clean_data();
        rights.hasThrow("SEND_MESSAGES");
    }

    const ephermal = (message.flags & (1 << 6)) !== 0;
    if (!known.deferChannelUpdates && !isEdit && !ephermal && channel.isThread() && message.type !== MessageType.THREAD_STARTER_MESSAGE && message.id !== channel.id) {
        const rep = Channel.getRepository();
        await rep.increment({ id: channel.id }, "message_count", 1);
        await rep.increment({ id: channel.id }, "total_message_sent", 1);
        channel.message_count = (channel.message_count ?? 0) + 1;
        channel.total_message_sent = (channel.total_message_sent ?? 0) + 1;
    }
    if (!known.deferChannelUpdates && !isEdit && !ephermal) {
        channel.last_message_id = message.id;
        await Channel.update({ id: channel.id }, { last_message_id: message.id });
    }

    // TODO: Removed cloud attachment handling being inline - handle components!

    if (opts.application_id) {
        message.application = await Application.findOneOrFail({
            where: { id: opts.application_id },
        });
    }

    if (opts.webhook_id) {
        message.webhook = await Webhook.findOneOrFail({
            where: { id: opts.webhook_id },
        });

        message.author =
            (await User.findOne({
                where: { id: opts.webhook_id },
            })) || undefined;

        if (!message.author) {
            message.author = User.create({
                id: opts.webhook_id,
                username: message.webhook.name,
                discriminator: "0000",
                avatar: message.webhook.avatar,
                public_flags: 0,
                premium: false,
                premium_type: 0,
                bot: true,
                created_at: new Date(),
                verified: true,
                rights: "0",
                data: {
                    valid_tokens_since: new Date(),
                },
            });

            await message.author.save();
        } else if (message.author.username !== message.webhook.name || (message.author.avatar ?? null) !== (message.webhook.avatar ?? null)) {
            message.author.username = message.webhook.name;
            message.author.avatar = message.webhook.avatar;
            await User.update({ id: message.author.id }, { username: message.author.username, avatar: message.author.avatar ?? (() => "NULL") });
        }

        if (!isEdit) message.avatar = message.webhook.avatar ?? undefined;
        if (opts.username) {
            message.username = opts.username;
            message.author.username = message.username;
        }
        if (Config.get().externalRequests.thirdParty && opts.avatar_url && URL.canParse(opts.avatar_url) && /^https?:$/.test(new URL(opts.avatar_url).protocol)) {
            const avatar = await fetchPublicUrl(opts.avatar_url, { signal: AbortSignal.timeout(10_000) })
                .then(async (res) => {
                    const type = res.headers.get("content-type");
                    if (!res.ok || !type?.startsWith("image/")) return undefined;
                    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
                    return handleFile(`/avatars/${opts.webhook_id}`, `data:${type};base64,${base64}`, `webhook:${opts.webhook_id}`);
                })
                .catch(() => undefined);
            if (avatar) {
                message.avatar = avatar;
                message.author.avatar = avatar;
            }
        }
    } else {
        if (!permission && opts.interaction_metadata) {
            const appPermission = await getPermission(opts.author_id, channel.guild_id, channel).catch(() => null);
            permission = new Permissions(
                (appPermission?.bitfield ?? 0n) |
                    new Permissions(["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS", "ATTACH_FILES", "READ_MESSAGE_HISTORY", "USE_EXTERNAL_EMOJIS", "USE_EXTERNAL_STICKERS"])
                        .bitfield,
            );
            if (appPermission) permission.cache = appPermission.cache;
        }
        permission ||= authorPermission ?? (await getPermission(opts.author_id, channel.guild_id, channel));
        if (permission === null) throw new HTTPError("permission was null after getPermission", 500);
        permission.hasThrow("SEND_MESSAGES");
        if (permission.cache.member) {
            message.member = permission.cache.member;
        }

        if (opts.tts) permission.hasThrow("SEND_TTS_MESSAGES");
        if (opts.message_reference?.type === MessageReferenceType.FORWARD) {
            const { message_id, channel_id } = opts.message_reference;
            if (!message_id || !channel_id) throw new HTTPError("Forwards require message_id and channel_id", 400);
            const source = await Channel.findOneOrFail({ where: { id: channel_id } });
            const sourcePermission = await getPermission(opts.author_id, source.guild_id, source);
            sourcePermission.hasThrow("VIEW_CHANNEL");
            sourcePermission.hasThrow("READ_MESSAGE_HISTORY");
            const forwarded = await Message.findOneOrFail({
                where: { id: message_id, channel_id },
                relations: { mentions: true, mention_roles: true, attachments: true, sticker_items: true },
            });
            message.message_reference = {
                type: MessageReferenceType.FORWARD,
                message_id,
                channel_id,
                guild_id: source.guild_id ?? undefined,
            };
            message.message_snapshots = [forwarded.toSnapshot()];
            message.referenced_message = undefined;
            message.type = MessageType.DEFAULT;
        } else if (opts.message_reference) {
            permission.hasThrow("READ_MESSAGE_HISTORY");
            if (!opts.message_reference.guild_id && channel.guild_id) opts.message_reference.guild_id = channel.guild_id;
            if (!opts.message_reference.channel_id) opts.message_reference.channel_id = opts.channel_id;

            if ((opts.message_reference.guild_id ?? null) !== (channel.guild_id ?? null)) throw new HTTPError("You can only reference messages from this guild");
            if (opts.message_reference.channel_id !== opts.channel_id && opts.type !== MessageType.THREAD_STARTER_MESSAGE && opts.type !== MessageType.THREAD_CREATED)
                throw new HTTPError("You can only reference messages from this channel");

            message.message_reference = opts.message_reference;
            if (message.message_reference.message_id) {
                const referenced = await Message.findOne({
                    where: {
                        id: opts.message_reference.message_id,
                    },
                    relations: {
                        author: true,
                        webhook: true,
                        application: true,
                        mentions: true,
                        mention_roles: true,
                        mention_channels: true,
                        sticker_items: true,
                        attachments: true,
                    },
                });
                if (!referenced && opts.message_reference.fail_if_not_exists !== false) throw DiscordApiErrors.UNKNOWN_MESSAGE;
                if (referenced && referenced.channel_id !== opts.message_reference.channel_id && opts.type !== MessageType.THREAD_STARTER_MESSAGE)
                    throw new HTTPError("Referenced message not found in the specified channel", 404);
                if (referenced) message.referenced_message = referenced;
                else message.message_reference = undefined;
                if (referenced && opts.type === MessageType.THREAD_STARTER_MESSAGE) await Message.fillReplies([referenced]);
            }
            if (
                message.message_reference &&
                MessageType.THREAD_STARTER_MESSAGE !== message.type &&
                MessageType.THREAD_CREATED !== message.type &&
                MessageType.POLL_RESULT !== message.type
            )
                message.type = MessageType.REPLY;
        }
    }

    // TODO: stickers/activity
    if (
        !allow_empty &&
        !((opts.flags ?? 0) & Number(MessageFlags.FLAGS.LOADING)) &&
        !opts.content &&
        !opts.embeds?.length &&
        !opts.attachments?.length &&
        !opts.sticker_ids?.length &&
        !opts.poll &&
        !opts.components?.length &&
        opts.message_reference?.type != 1 &&
        opts.type !== MessageType.THREAD_STARTER_MESSAGE
    ) {
        console.log("[Message] Rejecting empty message:", opts, message);
        throw new HTTPError("Empty messages are not allowed", 50006);
    }

    message.content = opts.content?.trim();
    message.soundboard_sounds = await resolveSoundmoji(message.content);

    if (message.poll) {
        message.poll.results = { answer_counts: [], is_finalized: false };

        if (opts.poll?.duration) {
            message.poll.expiry = new Date(Date.now() + opts.poll.duration * 3600000);
        }

        if (opts.poll?.answers) {
            if (opts.poll.answers.length < 1 || opts.poll.answers.length > 10) {
                const errors: ErrorList = {};
                errors["poll"] = makeObjectErrorContent("BASE_TYPE_BAD_LENGTH", "Must be between 1 and 10 in length.");
                throw new FieldError(50035, "Invalid form body", errors);
            }

            for (let i = 0; i < opts.poll.answers.length; i++) {
                message.poll.answers[i].answer_id = i + 1;
            }
        }
    }

    resolveMessageComponentAttachments(message.components, message.attachments ?? []);

    await handleMessageMentionsAsync(message, opts.allowed_mentions, isEdit, !opts.webhook_id && !opts.interaction_metadata ? (permission ?? undefined) : undefined);

    const attachmentIndices = new Map(message.attachments?.map((attachment, index) => [`attachment://${attachment.filename}`, index]));
    const attachmentsToRemove = new Set<number>();
    function fetchAttachment(url: string | undefined): Attachment | undefined {
        if (url == undefined) {
            return undefined;
        }
        const index = attachmentIndices.get(url);
        if (index === undefined) {
            return undefined;
        }
        const attachment = message.attachments?.[index];
        if (attachment === undefined) {
            return undefined;
        }
        attachmentsToRemove.add(index);
        return attachment;
    }
    for (const embed of message.embeds) {
        embed.type ||= EmbedType.rich;
        const footer = embed.footer;
        const footerAttachment = fetchAttachment(footer?.icon_url);
        if (footerAttachment !== undefined) {
            footer!.icon_url = footerAttachment.toJSON().url;
            footer!.proxy_icon_url = footerAttachment.toJSON().proxy_url;
        }

        const image = embed.image;
        const imageAttachment = fetchAttachment(image?.url);
        if (imageAttachment !== undefined) {
            image!.url = imageAttachment.toJSON().url;
            image!.proxy_url = imageAttachment.toJSON().proxy_url;
            if (imageAttachment.width && imageAttachment.height) {
                image!.width = imageAttachment.width;
                image!.height = imageAttachment.height;
            }
        }

        const author = embed.author;
        const authorAttachment = fetchAttachment(author?.icon_url);
        if (authorAttachment !== undefined) {
            author!.icon_url = authorAttachment.toJSON().url;
            author!.proxy_icon_url = authorAttachment.toJSON().proxy_url;
        }
    }
    message.attachments = message.attachments?.filter((_, index) => !attachmentsToRemove.has(index));

    // TODO: check and put it all in the body

    return message;
}

// TODO: cache link result in db
export async function postHandleMessage(message: Message, permission?: Permissions) {
    message.clean_data();

    message.embeds ??= [];
    message.embeds.forEach((embed) => {
        // we need to handle false-y values (empty string) here, so cant use ??=
        embed.type ||= EmbedType.rich;
    });

    if (message.isWebhook || (permission ?? (await getPermission(message.author_id, message.channel.guild_id, message.channel_id))).has(Permissions.FLAGS.EMBED_LINKS))
        await fillMessageUrlEmbeds(message);
}

export async function syncCrosspostCopies(source: Message, deleted = false) {
    if (!(source.flags & Number(MessageFlags.FLAGS.CROSSPOSTED))) return;
    const copies = await Message.find({
        where: {
            message_reference: Raw((alias) => `${alias} ->> 'message_id' = :source_id`, {
                source_id: source.id,
            }),
        },
        relations: { channel: true, webhook: true },
    });
    for (const copy of copies.filter((c) => c.flags & Number(MessageFlags.FLAGS.IS_CROSSPOST))) {
        if (deleted) {
            copy.flags |= Number(MessageFlags.FLAGS.SOURCE_MESSAGE_DELETED);
            copy.content = "";
            copy.embeds = [];
        } else {
            copy.content = source.content;
            copy.embeds = (source.embeds ?? []).filter((embed) => embed.type === EmbedType.rich);
            copy.edited_timestamp = source.edited_timestamp ?? new Date();
        }
        await Message.update(
            { id: copy.id },
            {
                flags: copy.flags,
                content: copy.content,
                embeds: copy.embeds,
                edited_timestamp: copy.edited_timestamp,
            },
        );
        await emitEvent({
            event: "MESSAGE_UPDATE",
            channel_id: copy.channel_id,
            data: { ...copy.toJSON(), nonce: undefined },
        } satisfies MessageUpdateEvent);
        if (!deleted) postHandleMessage(copy).catch((e) => console.error("[Crosspost] post-message handler failed", e));
    }
}

export async function sendMessage(opts: MessageOptions) {
    const message = await handleMessage({ ...opts, timestamp: new Date() });

    const ephemeral = (message.flags & Number(MessageFlags.FLAGS.EPHEMERAL)) !== 0;
    await getDatabase()?.transaction(async (entityManager) => {
        await entityManager.save(message);
        await entityManager.save(message.channel);
        if (message.attachments && message.attachments.length > 0) await entityManager.save(message.attachments);
    });
    scheduleSavedPoll(message);
    await Promise.all([
        emitEvent({
            event: "MESSAGE_CREATE",
            ...(ephemeral ? { user_id: message.interaction_metadata?.user_id } : { channel_id: message.channel_id }),
            data: { ...message.toJSON(), nonce: message.nonce ?? undefined },
        } satisfies MessageCreateEvent),
    ]);

    // no await as it should catch error non-blockingly
    postHandleMessage(message).catch((e) => console.error("[Message] post-message handler failed", e));

    return message;
}

// Makes for concise code, inspired by Nix' lib.trace
function logPassthru<T>(obj: T, ...data: unknown[]) {
    console.log(...data);
    return obj;
}
export async function processMessageOptionAttachments(source: MessageOptions, destination: Message) {
    if (!source.attachments || source.attachments.length == 0) return;
    const logp = `[Message/${destination.id}/Attachments]`;
    console.log("[Message] Processing attachments for message", source.id, "->", source.attachments);
    const tasks = source.attachments?.map(async (src): Promise<Attachment> => {
        if (src instanceof Attachment) return logPassthru(src, logp, `Got Attachment instance`);
        if (isCloudAttachment(src)) {
            const result = logPassthru(
                await convertCloudAttachmentToAttachment(src, destination.channel_id!, destination.id, destination.author_id),
                logp,
                "Got MessageCreateCloudAttachment contents",
            );

            result.flags = 0 as AttachmentFlags;
            result.flags |= (src.is_clip ? 1 : 0) * (AttachmentFlags.IS_CLIP as number);
            result.flags |= (src.is_remix ? 1 : 0) * (AttachmentFlags.IS_REMIX as number);
            result.flags |= (src.is_thumbnail ? 1 : 0) * (AttachmentFlags.IS_THUMBNAIL as number);
            result.flags |= (src.is_spoiler ? 1 : 0) * (AttachmentFlags.IS_SPOILER as number);
            return logPassthru(result, logp, "Got MessageCreateCloudAttachment contents");
        }
        if (isInternalCdnAttachment(src)) {
            const result = Attachment.create({
                ...src,
            });

            // result.flags = 0 as AttachmentFlags;
            // result.flags &= (src.is_clip ? 1 : 0) * (AttachmentFlags.IS_CLIP as number);
            // result.flags &= (src.is_remix ? 1 : 0) * (AttachmentFlags.IS_REMIX as number);
            // result.flags &= (src.is_thumbnail ? 1 : 0) * (AttachmentFlags.IS_THUMBNAIL as number);
            // result.flags &= (src.is_spoiler ? 1 : 0) * (AttachmentFlags.IS_SPOILER as number);
            return result;
        }
        throw new Error(logp + " Unhandled attachment: " + JSON.stringify(src));
    });

    destination.attachments = [];
    for (const task of tasks) {
        destination.attachments.push(await task);
    }
}

export function isCloudAttachment(attachment: MessageOptionAttachment) {
    return "uploaded_filename" in attachment;
}

export function isInternalCdnAttachment(attachment: MessageOptionAttachment) {
    return "url" in attachment;
}

export async function convertCloudAttachmentToAttachment(
    cloudAttachmentReference: MessageCreateCloudAttachment,
    destinationChannelId: string,
    destinationMessageId: string,
    actorId: string | undefined,
) {
    const numericId = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
    if (!numericId(actorId) || !numericId(destinationChannelId) || !numericId(destinationMessageId)) throw new HTTPError("Attachment is unavailable", 404);
    const path = cloudAttachmentReference.uploaded_filename;
    if (typeof path !== "string" || !/^\d{1,19}\/[A-Za-z0-9_-]{1,256}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9._-]{1,255}$/.test(path))
        throw new HTTPError("Attachment is unavailable", 404);
    const cloudAttachment = await CloudAttachment.findOne({
        where: { uploadFilename: path, userId: actorId, channelId: destinationChannelId },
    });
    const [channelId, , slot, filename] = path.split("/");
    if (
        !cloudAttachment ||
        channelId !== destinationChannelId ||
        slot !== cloudAttachment.userAttachmentId ||
        filename !== cloudAttachment.userFilename ||
        filename === "." ||
        filename === ".." ||
        !Number.isSafeInteger(cloudAttachment.size) ||
        cloudAttachment.size! < 0
    )
        throw new HTTPError("Attachment is unavailable", 404);
    const permission = await getPermission(actorId, undefined, destinationChannelId);
    if (!permission.has(Permissions.FLAGS.VIEW_CHANNEL) || !permission.has(Permissions.FLAGS.ATTACH_FILES)) throw new HTTPError("Missing attachment permissions", 403);

    const cloneResponse = await fetch(
        `${Config.get().cdn.endpointPrivate?.replace(/\/+$/, "")}/attachments/${cloudAttachment.uploadFilename}/clone_to_message/${destinationMessageId}?channel_id=${destinationChannelId}`,
        {
            method: "POST",
            headers: {
                signature: Config.get().security.requestSignature || "",
            },
        },
    );

    if (!cloneResponse.ok) {
        console.error(`[Message] Failed to clone attachment ${cloudAttachment.userFilename} to message ${destinationMessageId}`);
        throw new HTTPError("Failed to process attachment: " + (await cloneResponse.text()), 500);
    }

    const cloneRespBody = (await cloneResponse.json()) as { success: boolean; new_path: string };

    const realAtt = Attachment.create({
        channel_id: destinationChannelId,
        message_id: destinationMessageId,

        filename: cloudAttachment.userFilename,
        size: cloudAttachment.size,
        height: cloudAttachment.height,
        width: cloudAttachment.width,
        content_type: cloudAttachment.contentType || cloudAttachment.userOriginalContentType,

        title: cloudAttachmentReference.title,
        duration_secs: cloudAttachmentReference.duration_secs,
        clip_created_at: cloudAttachmentReference.clip_created_at,
        description: cloudAttachmentReference.description,
        waveform: cloudAttachmentReference.waveform,
    });

    return realAtt;
}

async function handleMessageMentionsAsync(message: Message, allowed?: AllowedMentions | null, isEdit = false, authorPermission?: Permissions) {
    const sw = Stopwatch.startNew(),
        totalSw = Stopwatch.startNew();
    const trace: TraceNode = { micros: 0, calls: [] };
    const traceRoot: TraceRoot = ["handleMessageMentionsAsync", trace];

    const channel =
        message.channel?.id === message.channel_id && message.channel.recipients
            ? message.channel
            : await Channel.findOneOrFail({
                  where: { id: message.channel_id },
                  relations: { recipients: true },
              });
    trace.calls.push(`getChannel(${channel.id})`, {
        micros: sw.getElapsedAndReset().totalMicroseconds,
    });

    const permissionTargetId = message.isWebhook ? message.webhook?.application_id : (message.author_id ?? message.author?.id);
    const permission =
        permissionTargetId != null
            ? !message.isWebhook && authorPermission
                ? authorPermission
                : await getPermission(permissionTargetId, channel.guild_id, channel)
            : message.guild_id != null
              ? new Permissions((await Role.findOneOrFail({ where: { id: message.guild_id ?? message.guild?.id } })).permissions)
              : Permissions.DEFAULT_DM_PERMISSIONS;
    trace.calls.push(`getPermissions`, { micros: sw.getElapsedAndReset().totalMicroseconds });

    let content = message.flags & COMPONENTS_V2 ? messageComponentText(message.components) : message.content;

    // TODO: sets
    // root@Rory - 20/02/2023 - This breaks channel mentions in test client. We're not sure this was used in older clients.
    //const mention_channel_ids = [] as string[];
    let mention_everyone = false;
    let mention_here = false;
    const mention_user_id_set = new Set<string>();
    const mention_role_id_set = new Set<string>();
    let mentionedRoles: Role[] = [];

    if (content) {
        const contentSw = Stopwatch.startNew();
        const contentTrace: TraceNode = { micros: 0, calls: [] };
        // TODO: explicit-only mentions
        // TODO: make mentions lazy
        content = content.replace(/ *`[^)]*` */g, ""); // remove codeblocks
        // root@Rory - 20/02/2023 - This breaks channel mentions in test client. We're not sure this was used in older clients.
        /*for (const [, mention] of content.matchAll(CHANNEL_MENTION)) {
			if (!mention_channel_ids.includes(mention))
				mention_channel_ids.push(mention);
		}*/
        contentTrace.calls.push("filterCodeblocks", {
            micros: sw.getElapsedAndReset().totalMicroseconds,
        });

        const allows = (kind: "users" | "roles" | "everyone", list?: string[]) => (id?: string) => !allowed || allowed.parse?.includes(kind) || (!!id && !!list?.includes(id));
        const allowsUser = allows("users", allowed?.users);
        const allowsRole = allows("roles", allowed?.roles);
        for (const [, mention] of content.matchAll(USER_MENTION)) if (allowsUser(mention)) mention_user_id_set.add(mention);
        for (const [, mention] of content.matchAll(ROLE_MENTION)) if (allowsRole(mention)) mention_role_id_set.add(mention);
        if (
            allows("everyone")() &&
            (message.webhook?.id || message.webhook_id || permission?.has("MENTION_EVERYONE") || channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM)
        ) {
            mention_everyone = !!content.match(EVERYONE_MENTION);
            mention_here = !!content.match(HERE_MENTION);
        }
        contentTrace.calls.push("parseMentions", { micros: sw.getElapsedAndReset().totalMicroseconds });

        mentionedRoles =
            !channel.guild_id || !mention_role_id_set.size
                ? []
                : await Role.find({
                      where: { id: In(mention_role_id_set.values().toArray()), guild_id: channel.guild_id },
                  });
        contentTrace.calls.push("queryMentionRoles", {
            micros: sw.getElapsedAndReset().totalMicroseconds,
        });

        //TODO: should this throw at all?
        if (mention_role_id_set.size != mentionedRoles.length) {
            const missingRoles = mention_role_id_set
                .values()
                .filter((x) => !mentionedRoles.find((r) => r.id == x))
                .toArray();
            throw new HTTPError("Mentioned invalid roles: " + missingRoles.join(", "), 500);
        }

        if (!(message.webhook?.id || message.webhook_id || permission?.has("MANAGE_ROLES"))) {
            mentionedRoles = mentionedRoles.filter((x) => x.mentionable);
            mention_role_id_set.clear();
            mentionedRoles.forEach((r) => mention_role_id_set.add(r.id));
        }

        contentTrace.calls.push("validateMentionRoles", {
            micros: sw.getElapsedAndReset().totalMicroseconds,
        });
        contentTrace.micros = contentSw.elapsed().totalMicroseconds;
        trace.calls.push("parseContent", contentTrace);
    }

    if (message.message_reference?.message_id && message.message_reference.type !== MessageReferenceType.FORWARD) {
        const loaded = message.referenced_message;
        const referencedMessage =
            loaded?.id === message.message_reference.message_id && loaded.channel_id === message.channel_id
                ? loaded
                : await Message.findOne({
                      where: {
                          id: message.message_reference.message_id,
                          channel_id: message.channel_id,
                      },
                      relations: {
                          mentions: true,
                          mention_roles: true,
                      },
                  });
        if (referencedMessage && referencedMessage.author_id !== message.author_id && allowed?.replied_user !== false) {
            const repliedUser =
                referencedMessage.author?.id === referencedMessage.author_id ? referencedMessage.author : await User.findOne({ where: { id: referencedMessage.author_id } });
            if (repliedUser) message.mentions.push(repliedUser);
        }

        if (message.embeds[0]?.type === EmbedType.poll_result) {
            const author = await User.findOne({ where: { id: message.author_id } });
            if (author) message.mentions.push(author);
        }
        trace.calls.push("handleMessageReference", {
            micros: sw.getElapsedAndReset().totalMicroseconds,
        });
    }

    // root@Rory - 20/02/2023 - This breaks channel mentions in test client. We're not sure this was used in older clients.
    /*message.mention_channels = mention_channel_ids.map((x) =>
		Channel.create({ id: x }),
	);*/
    message.mention_roles = mention_role_id_set.size == 0 ? [] : mentionedRoles;
    const unresolvedUserIds = mention_user_id_set
        .values()
        .toArray()
        .filter((id) => !message.mentions.some((u) => u.id === id));
    const mentionedUsers = unresolvedUserIds.length ? await User.find({ where: { id: In(unresolvedUserIds) } }) : [];
    message.mentions = [...message.mentions, ...mentionedUsers];
    message.mention_everyone = mention_everyone || mention_here;
    trace.calls.push("fillMessageMentionProperties", {
        micros: sw.getElapsedAndReset().totalMicroseconds,
    });

    const fillInMissingIDs = async (ids: string[], trace?: TraceSubTree) => {
        const fillMessageSw = Stopwatch.startNew(),
            subSw = Stopwatch.startNew();
        const subTrace: TraceSubTree = { micros: 0, calls: [] };
        try {
            const uniqueIds = [...new Set(ids)];
            for (let offset = 0; offset < uniqueIds.length; offset += 1000) {
                const chunk = uniqueIds.slice(offset, offset + 1000);
                const states = await ReadState.find({
                    where: {
                        user_id: In(chunk),
                        channel_id: channel.id,
                        read_state_type: ReadStateType.CHANNEL,
                    },
                    select: { user_id: true },
                });
                subTrace.calls.push("findReadStates", {
                    micros: subSw.getElapsedAndReset().totalMicroseconds,
                });

                const existingIds = new Set(states.map((state) => state.user_id));
                const missingIds = chunk.filter((id) => !existingIds.has(id));
                subTrace.calls.push("collectMissingIds", {
                    micros: subSw.getElapsedAndReset().totalMicroseconds,
                });
                if (!missingIds.length) continue;

                const newStates = missingIds.map((user_id) => ({
                    id: Snowflake.generate(),
                    user_id,
                    channel_id: channel.id,
                    read_state_type: ReadStateType.CHANNEL,
                }));
                await ReadState.createQueryBuilder().insert().values(newStates).orIgnore().execute();
                subTrace.calls.push("insertNewReadStatesChunked", {
                    micros: subSw.getElapsedAndReset().totalMicroseconds,
                });
            }
        } finally {
            trace?.calls.push(`fillInMissingIDs(${ids.length})`, {
                micros: fillMessageSw.getElapsedAndReset().totalMicroseconds,
                calls: subTrace.calls,
            });
        }
    };

    if (isEdit) {
        trace.calls.push("skipReadStatesForEdit", {
            micros: sw.getElapsedAndReset().totalMicroseconds,
        });
    } else if ((message.flags & (1 << 6)) !== 0) {
        // ephemeral messages
        const id = message.interaction_metadata?.user_id;
        if (id) {
            let pinged = mention_everyone || channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM;
            if (!pinged) pinged = !!message.mentions.find((user) => user.id === id);
            // TODO: can we somehow rewrite this into an In(...) query?
            if (!pinged && message.mention_roles?.length)
                pinged =
                    (await Member.count({
                        where: {
                            id,
                            guild_id: channel.guild_id,
                            roles: { id: In(message.mention_roles.map((r) => r.id)) },
                        },
                    })) > 0;
            if (pinged) {
                //stuff
            }
        }
        trace.calls.push("ephemeralPinged", { micros: sw.getElapsedAndReset().totalMicroseconds });
    } else {
        const users = await getMentionedUsers({
            channel,
            author_id: message.author_id ?? message.author?.id,
            user_ids: message.mentions.map((user) => user.id),
            role_ids: message.mention_roles.map((role) => role.id),
            everyone: mention_everyone,
            here: mention_here,
        });
        trace.calls.push("getMentionedUsers", { micros: sw.getElapsedAndReset().totalMicroseconds });

        if (users.size) {
            await fillInMissingIDs([...users], trace);
            await ReadState.query(
                `UPDATE read_states SET mention_count = mention_count + 1 WHERE channel_id = $1 AND read_state_type = $2 AND ${sqlArrayIncludes("user_id", "$3")}`,
                [channel.id, ReadStateType.CHANNEL, [...users]],
            );
            trace.calls.push("updateMentionedUserReadStates", {
                micros: sw.getElapsedAndReset().totalMicroseconds,
            });
        }
    }

    trace.micros = totalSw.elapsed().totalMicroseconds;
    if (process.env.LOG_MENTION_TRACE === "true") new console.Console({ stdout: process.stdout, inspectOptions: { depth: 20 } }).log("Mention handling trace:", trace);
}
