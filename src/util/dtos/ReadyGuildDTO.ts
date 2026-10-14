import { Channel, Emoji, Guild, Role, Sticker } from "../../database/entities";
import { ChannelOverride, ChannelType, GuildTheme, PublicMember, PublicUser, UserGuildSettings } from "@spacebar/schemas";

// TODO: this is not the best place for this type
export type ReadyUserGuildSettingsEntries = Omit<UserGuildSettings, "channel_overrides"> & {
    channel_overrides: (ChannelOverride & { channel_id: string })[];
};

// TODO: probably should move somewhere else
export interface ReadyPrivateChannel {
    id: string;
    flags: number;
    is_spam: boolean;
    last_message_id?: string;
    recipients: PublicUser[];
    type: ChannelType.DM | ChannelType.GROUP_DM;
}

export type GuildOrUnavailable = { id: string; unavailable: boolean } | (Guild & { joined_at?: Date; unavailable: undefined; threads: Channel[] });

const guildIsAvailable = (guild: GuildOrUnavailable): guild is Guild & { joined_at: Date; unavailable: false; threads: Channel[] } => guild.unavailable != true;

export interface IReadyGuildDTO {
    federated_instance?: string;
    application_command_counts?: { 1: number; 2: number; 3: number }; // ????????????
    channels: Channel[];
    data_mode: string; // what is this
    emojis: Emoji[];
    guild_scheduled_events: unknown[]; // TODO
    id: string;
    large: boolean | undefined;
    lazy: boolean;
    member_count: number | undefined;
    members: PublicMember[];
    premium_subscription_count: number | undefined;
    properties: {
        name: string;
        description?: string | null;
        icon?: string | null;
        splash?: string | null;
        banner?: string | null;
        features: string[];
        preferred_locale?: string | null;
        owner_id?: string | null;
        application_id?: string | null;
        afk_channel_id?: string | null;
        afk_timeout: number | undefined;
        system_channel_id?: string | null;
        verification_level: number | undefined;
        explicit_content_filter: number | undefined;
        default_message_notifications: number | undefined;
        mfa_level: number | undefined;
        vanity_url_code?: string | null;
        premium_tier: number | undefined;
        premium_progress_bar_enabled: boolean;
        incidents_data: unknown | null;
        system_channel_flags: number | undefined;
        discovery_splash?: string | null;
        rules_channel_id?: string | null;
        public_updates_channel_id?: string | null;
        max_video_channel_users: number | undefined;
        max_members: number | undefined;
        nsfw_level: number | undefined;
        hub_type?: unknown | null; // ????

        home_header: null; // TODO
        latest_onboarding_question_id: null; // TODO
        safety_alerts_channel_id: string | null;
        max_stage_video_channel_users: 50; // TODO
        nsfw: boolean;
        id: string;
        premium_features?: Guild["premium_features"];
        profile?: { tag: string; badge: string | null } | null;
        theme?: GuildTheme | null;
    };
    roles: Role[];
    stage_instances: unknown[];
    stickers: Sticker[];
    threads: unknown[];
    version: number;
    guild_hashes: unknown;
    unavailable: boolean;
    partial_updates?: GuildPartialUpdates;
}

export interface GuildPartialUpdates {
    channels: Channel[];
    roles: Role[];
    emojis: Emoji[];
    stickers: Sticker[];
    deleted_channel_ids: string[];
    deleted_role_ids: string[];
    deleted_emoji_ids: string[];
    deleted_sticker_ids: string[];
}

export type GuildEntityDelete = { entity_type: number; entity_id: string; version: string };

export const GUILD_VERSION_HORIZON = 30 * 24 * 60 * 60 * 1000;
const GUILD_VERSION_SETTLE = 10_000;

const versionOf = (entity: { version?: string | number } | undefined) => Number(entity?.version ?? 0) || 0;

// Identify hands this guilds that already went through Guild.toJSON(), where the profile is { tag, badge: <hash> },
// as well as raw guilds where the hash is badge_hash and badge is the badge type; both come out as { tag, badge: <hash> }
function publicGuildProfile(profile: { tag?: string | null; badge?: unknown; badge_hash?: string | null } | null | undefined) {
    if (!profile?.tag) return null;
    return {
        tag: profile.tag,
        badge: profile.badge_hash ?? (typeof profile.badge === "string" ? profile.badge : null),
    };
}

export class ReadyGuildDTO implements IReadyGuildDTO {
    federated_instance?: string;
    application_command_counts?: { 1: number; 2: number; 3: number }; // ????????????
    channels: Channel[];
    data_mode: string; // what is this
    emojis: Emoji[];
    guild_scheduled_events: unknown[];
    id: string;
    large: boolean | undefined;
    lazy: boolean;
    member_count: number | undefined;
    members: PublicMember[];
    premium_subscription_count: number | undefined;
    properties: {
        name: string;
        description?: string | null;
        icon?: string | null;
        splash?: string | null;
        banner?: string | null;
        features: string[];
        preferred_locale?: string | null;
        owner_id?: string | null;
        application_id?: string | null;
        afk_channel_id?: string | null;
        afk_timeout: number | undefined;
        system_channel_id?: string | null;
        verification_level: number | undefined;
        explicit_content_filter: number | undefined;
        default_message_notifications: number | undefined;
        mfa_level: number | undefined;
        vanity_url_code?: string | null;
        premium_tier: number | undefined;
        premium_progress_bar_enabled: boolean;
        incidents_data: unknown | null;
        system_channel_flags: number | undefined;
        discovery_splash?: string | null;
        rules_channel_id?: string | null;
        public_updates_channel_id?: string | null;
        max_video_channel_users: number | undefined;
        max_members: number | undefined;
        nsfw_level: number | undefined;
        hub_type?: unknown | null; // ????

        home_header: null; // TODO
        latest_onboarding_question_id: null; // TODO
        safety_alerts_channel_id: string | null;
        max_stage_video_channel_users: 50; // TODO
        nsfw: boolean;
        id: string;
        premium_features?: Guild["premium_features"];
        profile?: { tag: string; badge: string | null } | null;
        theme?: GuildTheme | null;
    };
    roles: Role[];
    stage_instances: unknown[];
    stickers: Sticker[];
    threads: unknown[];
    version: number;
    guild_hashes: unknown;
    unavailable: boolean;
    joined_at: Date;
    partial_updates?: GuildPartialUpdates;

    constructor(guild: GuildOrUnavailable, sync?: { version: number; deletes: GuildEntityDelete[] }) {
        if (!guildIsAvailable(guild)) {
            this.id = guild.id;
            this.unavailable = true;
            return;
        }

        this.application_command_counts = {
            1: 5,
            2: 2,
            3: 2,
        }; // ????? // emma: this appears to always be an empty attrset...
        this.channels = guild.channels;
        this.data_mode = "full";
        this.emojis = guild.emojis;
        this.guild_scheduled_events = (guild as { guild_scheduled_events?: unknown[] }).guild_scheduled_events ?? [];
        this.id = guild.id;
        this.large = guild.large;
        this.lazy = true; // ??????????
        this.member_count = guild.member_count;
        this.members = guild.members?.map((x) => x.toPublicMember());
        this.premium_subscription_count = guild.premium_subscription_count;
        if (guild.federated_instance) this.federated_instance = guild.federated_instance;
        this.properties = {
            name: guild.name,
            description: guild.description,
            icon: guild.icon,
            splash: guild.splash,
            banner: guild.banner,
            features: guild.features,
            preferred_locale: guild.preferred_locale,
            owner_id: guild.owner_id,
            application_id: null, // ?????
            afk_channel_id: guild.afk_channel_id,
            afk_timeout: guild.afk_timeout,
            system_channel_id: guild.system_channel_id,
            verification_level: guild.verification_level,
            explicit_content_filter: guild.explicit_content_filter,
            default_message_notifications: guild.default_message_notifications,
            mfa_level: guild.mfa_level,
            vanity_url_code: guild.vanity_url_code ?? null,
            premium_tier: guild.premium_tier,
            premium_progress_bar_enabled: guild.premium_progress_bar_enabled,
            incidents_data: guild.incidents_data ?? null,
            system_channel_flags: guild.system_channel_flags,
            discovery_splash: guild.discovery_splash,
            rules_channel_id: guild.rules_channel_id,
            public_updates_channel_id: guild.public_updates_channel_id,
            max_video_channel_users: guild.max_video_channel_users,
            max_members: guild.max_members,
            nsfw_level: guild.nsfw_level,
            hub_type: null,

            home_header: null,
            id: guild.id,
            latest_onboarding_question_id: null,
            max_stage_video_channel_users: 50, // TODO
            nsfw: guild.nsfw,
            safety_alerts_channel_id: guild.safety_alerts_channel_id ?? null,
            premium_features: guild.premium_features,
            profile: publicGuildProfile(guild.profile),
            theme: guild.theme ?? null,
        };
        this.roles = guild.roles.map((x) => (typeof x.toJSON === "function" ? x.toJSON() : x));
        this.stage_instances = (guild as { stage_instances?: unknown[] }).stage_instances ?? [];
        this.stickers = guild.stickers;
        this.threads = guild.threads;
        this.guild_hashes = {};
        this.joined_at = guild.joined_at;

        const channelsVersion = versionOf({
            version: (guild as { channels_version?: string }).channels_version,
        });
        const latest = Math.max(
            channelsVersion,
            ...[this.channels, this.roles, this.emojis, this.stickers].flatMap((list) => (list ?? []).map((entity) => versionOf(entity as { version?: string }))),
            ...(sync?.deletes ?? []).map((entry) => versionOf(entry)),
        );
        this.version = Math.min(latest, Date.now() - GUILD_VERSION_SETTLE);

        const since = sync?.version;
        if (since === undefined || !Number.isFinite(since) || since < Date.now() - GUILD_VERSION_HORIZON || since > latest) return;
        const changed = <T>(list: T[] | undefined) => (list ?? []).filter((entity) => versionOf(entity as { version?: string }) > since);
        const deleted = (type: number) => sync!.deletes.filter((entry) => entry.entity_type === type && versionOf(entry) > since).map((entry) => `${entry.entity_id}`);
        this.data_mode = "partial";
        this.partial_updates = {
            channels: channelsVersion > since ? this.channels : changed(this.channels),
            roles: changed(this.roles),
            emojis: changed(this.emojis),
            stickers: changed(this.stickers),
            deleted_channel_ids: deleted(0),
            deleted_role_ids: deleted(1),
            deleted_emoji_ids: deleted(2),
            deleted_sticker_ids: deleted(3),
        };
        Object.assign(this, {
            channels: undefined,
            roles: undefined,
            emojis: undefined,
            stickers: undefined,
        });
    }

    toJSON() {
        return this as IReadyGuildDTO;
    }
}
