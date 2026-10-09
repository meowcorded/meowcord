import { ConnectedAccount, Invite, Role, Emoji, Channel, User, Sticker, UserSettings, ReadState, PublicThreadMember } from "@spacebar/database";
import { Activity, Presence, IReadyGuildDTO, ReadyUserGuildSettingsEntries, ReadyPrivateChannel, GuildOrUnavailable, Snowflake, getApexExperiments } from "@spacebar/util";
import { JsonValue } from "@protobuf-ts/runtime";
import {
    ApplicationCommand,
    GuildCreateResponse,
    Interaction,
    InteractionFailureReason,
    PartialEmoji,
    PartialRelationshipSchema,
    PrivateStatus,
    PublicChannel,
    PublicMember,
    PublicMessage,
    PublicUser,
    PublicVoiceState,
    RelationshipSchema,
    RelationshipType,
    UserPrivate,
} from "@spacebar/schemas";

export interface Event {
    guild_id?: string;
    user_id?: string;
    session_id?: string;
    channel_id?: string;
    created_at?: Date;
    event: EVENT;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any;
    reconnect_delay?: number;
    origin?: string;
    transaction_id?: string;
}

// ! Custom Events that shouldn't get sent to the client but processed by the server

export interface InvalidatedEvent extends Event {
    event: "INVALIDATED";
}

export interface GuildCacheInvalidateEvent extends Event {
    event: "SB_GUILD_CACHE_INVALIDATE";
    data: { guild_id: string };
}

// ! END Custom Events that shouldn't get sent to the client but processed by the server

export interface ReadyEventData {
    v: number;
    user: UserPrivate;
    private_channels: ReadyPrivateChannel[]; // this will be empty for bots
    presences: Presence[];
    session_id: string; // resuming
    guilds: IReadyGuildDTO[] | GuildOrUnavailable[]; // depends on capability
    analytics_token?: string;
    connected_accounts?: ConnectedAccount[];
    consents?: {
        personalization?: {
            consented?: boolean;
        };
    };
    country_code?: string; // e.g. DE
    friend_suggestion_count?: number;
    geo_ordered_rtc_regions?: string[]; // ["europe","russie","india","us-east","us-central"]
    experiments?: [number, number, number, number, number][];
    guild_experiments?: [
        // ? what are guild_experiments?
        // this is the structure of it:
        number,
        null,
        number,
        [[number, { e: number; s: number }[]]],
        [number, [[number, [number, number]]]],
        { b: number; k: bigint[] }[],
    ][];
    apex_experiments?: ReturnType<typeof getApexExperiments>;
    guild_join_requests?: unknown[]; // ? what is this? this is new
    shard?: [number, number];
    user_settings?: ReturnType<UserSettings["toLegacy"]>;
    user_settings_proto?: string;
    user_settings_proto_json?: JsonValue;
    relationships?: RelationshipSchema[]; // TODO
    read_state: {
        entries: ReadState[]; // TODO
        partial: boolean;
        version: number;
    };
    user_guild_settings?: {
        entries: ReadyUserGuildSettingsEntries[];
        version: number;
        partial: boolean;
    };
    application?: {
        id: string;
        flags: number;
    };
    merged_members?: PublicMember[][];
    // probably all users who the user is in contact with
    users?: PublicUser[];
    sessions: unknown[];
    api_code_version: number;
    tutorial: number | null;
    resume_gateway_url: string;
    session_type: string;
    auth_session_id_hash: string;
    auth?: { authenticator_types: number[] };
    required_action?:
        | "REQUIRE_VERIFIED_EMAIL"
        | "REQUIRE_VERIFIED_PHONE"
        | "REQUIRE_CAPTCHA" // TODO: allow these to be triggered
        | "TOS_UPDATE_ACKNOWLEDGMENT"
        | "AGREEMENTS";
    notification_settings: {
        flags: number;
    };
    game_relationships: never[]; // what is this?
    auth_token?: string; // if enabled in capabilities
    _trace?: string[]; // trace of the request, used for debugging
}

export type TraceValue = { micros: number };
export type TraceSubTree = { micros: number; calls: TraceNode[] };
export type TraceNode = TraceSubTree | TraceValue | string;

export type TraceRoot = [string, { micros: number; calls: TraceNode[] }];

export interface ReadyEvent extends Event {
    event: "READY";
    data: ReadyEventData;
}

export interface ChannelCreateEvent extends Event {
    event: "CHANNEL_CREATE";
    data: PublicChannel;
}

export interface ChannelUpdateEvent extends Event {
    event: "CHANNEL_UPDATE";
    data: PublicChannel;
}

export interface ChannelDeleteEvent extends Event {
    event: "CHANNEL_DELETE";
    data: PublicChannel;
}

export interface ChannelPinsUpdateEvent extends Event {
    event: "CHANNEL_PINS_UPDATE";
    data: {
        guild_id?: string;
        channel_id: string;
        /**
         * @format ISO8601
         */
        last_pin_timestamp?: string;
    };
}

export interface ChannelRecipientAddEvent extends Event {
    event: "CHANNEL_RECIPIENT_ADD";
    data: {
        channel_id: string;
        user: PublicUser;
    };
}

export interface ChannelRecipientRemoveEvent extends Event {
    event: "CHANNEL_RECIPIENT_REMOVE";
    data: {
        channel_id: string;
        user: PublicUser;
    };
}

export interface GuildCreateEvent extends Event {
    event: "GUILD_CREATE";
    data: IReadyGuildDTO & {
        joined_at: Date | null;
        // TODO: add them to guild
        guild_scheduled_events: unknown[];
        guild_hashes: unknown;
        presences: never[];
        stage_instances: never[];
        threads: never[];
        embedded_activities: never[];
        // Only when not using PRIORITISED_READY_PAYLOAD capability
        voice_states?: PublicVoiceState[];
    };
}

export interface GuildUpdateEvent extends Event {
    event: "GUILD_UPDATE";
    data: GuildCreateResponse;
}

export interface GuildDeleteEvent extends Event {
    event: "GUILD_DELETE";
    data: {
        id: string;
        unavailable?: boolean;
    };
}

export interface GuildBanAddEvent extends Event {
    event: "GUILD_BAN_ADD";
    data: {
        guild_id: string;
        user: PublicUser;
        delete_message_secs?: number;
    };
}

export interface GuildJoinRequestCreateEvent extends Event {
    event: "GUILD_JOIN_REQUEST_CREATE" | "GUILD_JOIN_REQUEST_UPDATE";
    data: {
        guild_id: string;
        status: string;
        request: Record<string, unknown>;
    };
}

export interface GuildJoinRequestDeleteEvent extends Event {
    event: "GUILD_JOIN_REQUEST_DELETE";
    data: {
        guild_id: string;
        id: string;
        user_id: string;
    };
}

export interface AutoModerationRuleEvent extends Event {
    event: "AUTO_MODERATION_RULE_CREATE" | "AUTO_MODERATION_RULE_UPDATE" | "AUTO_MODERATION_RULE_DELETE";
    data: Record<string, unknown>;
}

export interface AutoModerationActionExecutionEvent extends Event {
    event: "AUTO_MODERATION_ACTION_EXECUTION";
    data: {
        guild_id: string;
        action: { type: number; metadata: Record<string, unknown> };
        rule_id: string;
        rule_trigger_type: number;
        user_id: string;
        channel_id?: string;
        message_id?: string;
        alert_system_message_id?: string;
        content: string;
        matched_keyword: string | null;
        matched_content: string | null;
    };
}

export interface AutoModerationMentionRaidDetectionEvent extends Event {
    event: "AUTO_MODERATION_MENTION_RAID_DETECTION";
    data: { guild_id: string; decision_id: string; suspicious_mention_activity_until: string };
}

export interface GuildBanRemoveEvent extends Event {
    event: "GUILD_BAN_REMOVE";
    data: {
        guild_id: string;
        user: PublicUser;
    };
}

export interface GuildEmojisUpdateEvent extends Event {
    event: "GUILD_EMOJIS_UPDATE";
    data: {
        guild_id: string;
        emojis: Emoji[];
    };
}

export interface GuildStickersUpdateEvent extends Event {
    event: "GUILD_STICKERS_UPDATE";
    data: {
        guild_id: string;
        stickers: Sticker[];
    };
}

export interface GuildIntegrationUpdateEvent extends Event {
    event: "GUILD_INTEGRATIONS_UPDATE";
    data: {
        guild_id: string;
    };
}

export interface GuildMemberAddEvent extends Event {
    event: "GUILD_MEMBER_ADD";
    data: PublicMember & {
        guild_id: string;
    };
}

export interface GuildMemberRemoveEvent extends Event {
    event: "GUILD_MEMBER_REMOVE";
    data: {
        guild_id: string;
        user: PublicUser;
    };
}

export interface GuildMemberUpdateEvent extends Event {
    event: "GUILD_MEMBER_UPDATE";
    data: {
        guild_id: string;
        roles: string[];
        user: PublicUser;
        nick?: string;
        joined_at?: Date;
        premium_since?: number;
        pending?: boolean;
    };
}

export interface GuildMembersChunkEvent extends Event {
    event: "GUILD_MEMBERS_CHUNK";
    data: {
        guild_id: string;
        members: PublicMember[];
        chunk_index: number;
        chunk_count: number;
        not_found?: string[];
        presences?: Presence[];
        nonce?: string;
    };
}

export interface GuildRoleCreateEvent extends Event {
    event: "GUILD_ROLE_CREATE";
    data: {
        guild_id: string;
        role: Role;
    };
}

export interface GuildRoleUpdateEvent extends Event {
    event: "GUILD_ROLE_UPDATE";
    data: {
        guild_id: string;
        role: Role;
    };
}

export interface GuildRoleDeleteEvent extends Event {
    event: "GUILD_ROLE_DELETE";
    data: {
        guild_id: string;
        role_id: string;
    };
}

export interface InviteCreateEvent extends Event {
    event: "INVITE_CREATE";
    data: Omit<Invite, "guild" | "channel"> & {
        channel_id: string;
        guild_id?: string;
    };
}

export interface InviteDeleteEvent extends Event {
    event: "INVITE_DELETE";
    data: {
        channel_id: string;
        guild_id?: string;
        code: string;
    };
}

export interface MessageCreateEvent extends Event {
    event: "MESSAGE_CREATE";
    data: PublicMessage;
}

export interface MessageUpdateEvent extends Event {
    event: "MESSAGE_UPDATE";
    data: PublicMessage;
}

export interface MessageDeleteEvent extends Event {
    event: "MESSAGE_DELETE";
    data: {
        id: string;
        channel_id: string;
        guild_id?: string;
    };
}

export interface MessageDeleteBulkEvent extends Event {
    event: "MESSAGE_DELETE_BULK";
    data: {
        ids: string[];
        channel_id: string;
        guild_id?: string;
    };
}

export interface MessagePollVoteAddEvent extends Event {
    event: "MESSAGE_POLL_VOTE_ADD";
    data: {
        answer_id: number;
        channel_id: string;
        guild_id?: string;
        message_id: string;
        user_id: string;
    };
}

export interface MessagePollVoteRemoveEvent extends Event {
    event: "MESSAGE_POLL_VOTE_REMOVE";
    data: {
        answer_id: number;
        channel_id: string;
        guild_id?: string;
        message_id: string;
        user_id: string;
    };
}

export const enum ReactionType {
    normal = 0,
    burst = 1,
}
export interface MessageReactionAddEvent extends Event {
    event: "MESSAGE_REACTION_ADD";
    data: {
        user_id: string;
        channel_id: string;
        message_id: string;
        guild_id?: string;
        member?: PublicMember;
        emoji: PartialEmoji;
        type: ReactionType;
        burst?: boolean;
        burst_colors?: string[];
        message_author_id?: string;
    };
}

export interface MessageReactionRemoveEvent extends Event {
    event: "MESSAGE_REACTION_REMOVE";
    data: {
        user_id: string;
        channel_id: string;
        message_id: string;
        guild_id?: string;
        emoji: PartialEmoji;
        type: ReactionType;
        burst?: boolean;
    };
}

export interface MessageReactionRemoveAllEvent extends Event {
    event: "MESSAGE_REACTION_REMOVE_ALL";
    data: {
        channel_id: string;
        message_id: string;
        guild_id?: string;
    };
}

export interface MessageReactionRemoveEmojiEvent extends Event {
    event: "MESSAGE_REACTION_REMOVE_EMOJI";
    data: {
        channel_id: string;
        message_id: string;
        guild_id?: string;
        emoji: PartialEmoji;
    };
}

export interface PresenceUpdateEvent extends Event {
    event: "PRESENCE_UPDATE";
    data: Presence;
}

export interface TypingStartEvent extends Event {
    event: "TYPING_START";
    data: {
        channel_id: string;
        user_id: string;
        timestamp: number;
        guild_id?: string;
        member?: PublicMember;
    };
}

export interface UserUpdateEvent extends Event {
    event: "USER_UPDATE";
    data: Omit<User, "data">;
}

export interface UserDeleteEvent extends Event {
    event: "USER_DELETE";
    data: {
        user_id: string;
    };
}

export interface OAuth2TokenCreateEvent extends Event {
    event: "OAUTH2_TOKEN_CREATE";
    data: { id: string; scopes: string[]; application: object };
}

export interface OAuth2TokenDeleteEvent extends Event {
    event: "OAUTH2_TOKEN_DELETE";
    data: { id: string; application_id: string };
}

// tells the client to refetch the commands of the apps a user installed on their account
export interface UserApplicationUpdateEvent extends Event {
    event: "USER_APPLICATION_UPDATE";
    data: { application_id: string };
}

export interface UserApplicationRemoveEvent extends Event {
    event: "USER_APPLICATION_REMOVE";
    data: { application_id: string };
}

export interface UserConnectionsUpdateEvent extends Event {
    event: "USER_CONNECTIONS_UPDATE";
}

export interface UserRequiredActionUpdateEvent extends Event {
    event: "USER_REQUIRED_ACTION_UPDATE";
    data: { required_action: "REQUIRE_VERIFIED_EMAIL" | null };
}

export interface VoiceStateUpdateEvent extends Event {
    event: "VOICE_STATE_UPDATE";
    data: Omit<PublicVoiceState, "guild_id" | "channel_id"> & {
        guild_id?: string | null;
        channel_id: string | null;
        member?: PublicMember;
    };
}

export interface VoiceServerUpdateEvent extends Event {
    event: "VOICE_SERVER_UPDATE";
    data: {
        token: string;
        guild_id: string | null;
        endpoint: string;
        channel_id?: string;
    };
}

export interface StreamCreateEvent extends Event {
    event: "STREAM_CREATE";
    data: {
        stream_key: string;
        rtc_server_id: string;
        rtc_channel_id?: string;
        viewer_ids: string[];
        region: string;
        paused: boolean;
    };
}

export interface StreamServerUpdateEvent extends Event {
    event: "STREAM_SERVER_UPDATE";
    data: {
        token: string;
        stream_key: string;
        endpoint: string;
        guild_id: string | null;
    };
}

export interface StreamDeleteEvent extends Event {
    event: "STREAM_DELETE";
    data: {
        stream_key: string;
    };
}

export interface WebhooksUpdateEvent extends Event {
    event: "WEBHOOKS_UPDATE";
    data: {
        guild_id: string;
        channel_id: string;
    };
}

export type ApplicationCommandPayload = ApplicationCommand & {
    guild_id: string;
};

export interface ApplicationCommandCreateEvent extends Event {
    event: "APPLICATION_COMMAND_CREATE";
    data: ApplicationCommandPayload;
}

export interface ApplicationCommandUpdateEvent extends Event {
    event: "APPLICATION_COMMAND_UPDATE";
    data: ApplicationCommandPayload;
}

export interface ApplicationCommandDeleteEvent extends Event {
    event: "APPLICATION_COMMAND_DELETE";
    data: ApplicationCommandPayload;
}

export interface InteractionCreateEvent extends Event {
    event: "INTERACTION_CREATE";
    data:
        | Interaction
        | {
              id: Snowflake;
              nonce?: string;
          };
}

export interface InteractionSuccessEvent extends Event {
    event: "INTERACTION_SUCCESS";
    data: {
        id: Snowflake;
        nonce: string;
    };
}

export interface InteractionFailureEvent extends Event {
    event: "INTERACTION_FAILURE";
    data: {
        id: Snowflake;
        nonce?: string;
        reason_code: InteractionFailureReason;
    };
}

export interface InteractionModalCreateEvent extends Event {
    event: "INTERACTION_MODAL_CREATE";
    data: {
        id: Snowflake;
        nonce?: string;
        channel_id: Snowflake;
        custom_id: string;
        title: string;
        components: object[];
        application: object;
    };
}

export interface EmbeddedActivityLocation {
    id: string;
    kind: "gc" | "pc";
    channel_id: Snowflake;
    guild_id?: Snowflake;
}

export interface EmbeddedActivityParticipant {
    user_id: Snowflake;
    session_id: string;
    nonce?: string;
    member?: object;
}

export interface EmbeddedActivityInstance {
    application_id: Snowflake;
    launch_id: Snowflake;
    composite_instance_id: string;
    location: EmbeddedActivityLocation;
    participants: EmbeddedActivityParticipant[];
}

export interface EmbeddedActivityUpdateV2Event extends Event {
    event: "EMBEDDED_ACTIVITY_UPDATE_V2";
    data: EmbeddedActivityInstance & { guild_id?: Snowflake };
}

export interface GuildApplicationCommandIndexUpdateEvent extends Event {
    event: "GUILD_APPLICATION_COMMAND_INDEX_UPDATE";
    data: {
        guild_id: Snowflake;
        application_command_counts: Record<number, number>;
        version: Snowflake;
    };
}

export interface ApplicationCommandAutocompleteResponseEvent extends Event {
    event: "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE";
    data: {
        nonce?: string;
        choices: object[];
    };
}

export interface MessageAckEvent extends Event {
    event: "MESSAGE_ACK";
    data: {
        channel_id: string;
        message_id: string;
        version?: number;
        manual?: boolean;
        mention_count?: number;
    };
}

export interface RecentMentionDeleteEvent extends Event {
    event: "RECENT_MENTION_DELETE";
    data: {
        message_id: string;
    };
}

export interface RelationshipAddEvent extends Event {
    event: "RELATIONSHIP_ADD";
    data: RelationshipSchema & {
        should_notify?: boolean;
    };
}
export interface RelationshipUpdateEvent extends Event {
    event: "RELATIONSHIP_UPDATE";
    data: PartialRelationshipSchema;
}

export interface RelationshipRemoveEvent extends Event {
    event: "RELATIONSHIP_REMOVE";
    data: PartialRelationshipSchema;
}

export interface GatewaySessionClientInfo {
    version: number;
    os: string;
    client: string;
}

export interface GatewaySession {
    session_id: string;
    activities: Activity[];
    hidden_activities: Activity[];
    client_info: GatewaySessionClientInfo;
    status: PrivateStatus;
    active?: boolean; // How is this even defined?
}

export interface SessionsReplace extends Event {
    event: "SESSIONS_REPLACE";
    data: GatewaySession[];
}

export interface GuildMemberListUpdate extends Event {
    event: "GUILD_MEMBER_LIST_UPDATE";
    data: {
        groups: { id: string; count: number }[];
        guild_id: string;
        id: string;
        member_count: number;
        online_count: number;
        ops: {
            index: number;
            item: {
                member?: PublicMember & { presence: Presence };
                group?: { id: string; count: number }[];
            };
        }[];
    };
}

export interface ThreadCreateEvent extends Event {
    event: "THREAD_CREATE";
    data: PublicChannel & { newly_created: boolean; member?: PublicThreadMember };
}

export interface ThreadUpdatEvent extends Event {
    event: "THREAD_UPDATE";
    data: PublicChannel;
}

export interface ThreadDeleteEvent extends Event {
    event: "THREAD_DELETE";
    data: Pick<PublicChannel, "id" | "guild_id" | "parent_id" | "type">;
}

export interface ThreadListSyncEvent extends Event {
    event: "THREAD_LIST_SYNC";
    data: {
        guild_id: string;
        channel_ids?: string[];
        threads: PublicChannel[];
        members: PublicThreadMember[];
    };
}

export interface ThreadMemberUpdateEvent extends Event {
    event: "THREAD_MEMBER_UPDATE";
    data: PublicThreadMember & { guild_id: string };
}

export interface ThreadMembersUpdateEvent extends Event {
    event: "THREAD_MEMBERS_UPDATE";
    data: {
        id: string;
        guild_id: string;
        member_count: number;
        added_members?: PublicThreadMember[];
        removed_member_ids?: string[];
    };
}

export interface CallPayload {
    channel_id: string;
    message_id: string;
    region: string;
    ringing: string[];
    ongoing_rings: Record<string, unknown>;
}

export interface CallCreateEvent extends Event {
    event: "CALL_CREATE";
    data: CallPayload & { voice_states: PublicVoiceState[]; embedded_activities: unknown[] };
}

export interface CallUpdateEvent extends Event {
    event: "CALL_UPDATE";
    data: CallPayload;
}

export interface CallDeleteEvent extends Event {
    event: "CALL_DELETE";
    data: { channel_id: string; unavailable?: boolean };
}

export type EventData =
    | GuildJoinRequestCreateEvent
    | GuildJoinRequestDeleteEvent
    | OAuth2TokenCreateEvent
    | OAuth2TokenDeleteEvent
    | UserApplicationUpdateEvent
    | UserApplicationRemoveEvent
    | CallCreateEvent
    | CallUpdateEvent
    | CallDeleteEvent
    | InvalidatedEvent
    | ReadyEvent
    | ChannelCreateEvent
    | ChannelUpdateEvent
    | ChannelDeleteEvent
    | ChannelPinsUpdateEvent
    | ChannelRecipientAddEvent
    | ChannelRecipientRemoveEvent
    | GuildCreateEvent
    | GuildUpdateEvent
    | GuildDeleteEvent
    | GuildBanAddEvent
    | GuildBanRemoveEvent
    | AutoModerationRuleEvent
    | AutoModerationActionExecutionEvent
    | AutoModerationMentionRaidDetectionEvent
    | GuildEmojisUpdateEvent
    | GuildIntegrationUpdateEvent
    | GuildMemberAddEvent
    | GuildMemberRemoveEvent
    | GuildMemberUpdateEvent
    | GuildMembersChunkEvent
    | GuildMemberListUpdate
    | GuildRoleCreateEvent
    | GuildRoleUpdateEvent
    | GuildRoleDeleteEvent
    | InviteCreateEvent
    | InviteDeleteEvent
    | MessageCreateEvent
    | MessageUpdateEvent
    | MessageDeleteEvent
    | MessageDeleteBulkEvent
    | MessagePollVoteAddEvent
    | MessagePollVoteRemoveEvent
    | MessageReactionAddEvent
    | MessageReactionRemoveEvent
    | MessageReactionRemoveAllEvent
    | MessageReactionRemoveEmojiEvent
    | PresenceUpdateEvent
    | TypingStartEvent
    | UserUpdateEvent
    | UserDeleteEvent
    | UserConnectionsUpdateEvent
    | UserRequiredActionUpdateEvent
    | VoiceStateUpdateEvent
    | VoiceServerUpdateEvent
    | WebhooksUpdateEvent
    | ApplicationCommandCreateEvent
    | ApplicationCommandUpdateEvent
    | ApplicationCommandDeleteEvent
    | InteractionCreateEvent
    | InteractionSuccessEvent
    | InteractionFailureEvent
    | MessageAckEvent
    | RelationshipAddEvent
    | RelationshipRemoveEvent
    | ThreadCreateEvent
    | ThreadUpdatEvent
    | ThreadDeleteEvent
    | ThreadListSyncEvent
    | ThreadMemberUpdateEvent
    | ThreadMembersUpdateEvent;

// located in collection events

export enum EVENTEnum {
    Ready = "READY",
    ReadySupplemental = "READY_SUPPLEMENTAL",
    ChannelCreate = "CHANNEL_CREATE",
    ChannelUpdate = "CHANNEL_UPDATE",
    ChannelDelete = "CHANNEL_DELETE",
    ChannelPinsUpdate = "CHANNEL_PINS_UPDATE",
    ChannelRecipientAdd = "CHANNEL_RECIPIENT_ADD",
    ChannelRecipientRemove = "CHANNEL_RECIPIENT_REMOVE",
    GuildCreate = "GUILD_CREATE",
    GuildUpdate = "GUILD_UPDATE",
    GuildDelete = "GUILD_DELETE",
    GuildBanAdd = "GUILD_BAN_ADD",
    GuildBanRemove = "GUILD_BAN_REMOVE",
    GuildEmojUpdate = "GUILD_EMOJI_UPDATE",
    GuildIntegrationsUpdate = "GUILD_INTEGRATIONS_UPDATE",
    GuildMemberAdd = "GUILD_MEMBER_ADD",
    GuildMemberRempve = "GUILD_MEMBER_REMOVE",
    GuildMemberUpdate = "GUILD_MEMBER_UPDATE",
    GuildMemberSpeaking = "GUILD_MEMBER_SPEAKING",
    GuildMembersChunk = "GUILD_MEMBERS_CHUNK",
    GuildMemberListUpdate = "GUILD_MEMBER_LIST_UPDATE",
    GuildRoleCreate = "GUILD_ROLE_CREATE",
    GuildRoleDelete = "GUILD_ROLE_DELETE",
    GuildRoleUpdate = "GUILD_ROLE_UPDATE",
    InviteCreate = "INVITE_CREATE",
    InviteDelete = "INVITE_DELETE",
    MessageCreate = "MESSAGE_CREATE",
    MessageUpdate = "MESSAGE_UPDATE",
    MessageDelete = "MESSAGE_DELETE",
    MessageDeleteBulk = "MESSAGE_DELETE_BULK",
    MessagePollVoteAdd = "MESSAGE_POLL_VOTE_ADD",
    MessageePollVoteRemove = "MESSAGE_POLL_VOTE_REMOVE",
    MessageReactionAdd = "MESSAGE_REACTION_ADD",
    MessageReactionRemove = "MESSAGE_REACTION_REMOVE",
    MessageReactionRemoveAll = "MESSAGE_REACTION_REMOVE_ALL",
    MessageReactionRemoveEmoji = "MESSAGE_REACTION_REMOVE_EMOJI",
    PresenceUpdate = "PRESENCE_UPDATE",
    TypingStart = "TYPING_START",
    UserUpdate = "USER_UPDATE",
    UserDelete = "USER_DELETE",
    UserConnectionsUpdate = "USER_CONNECTIONS_UPDATE",
    UserRequiredActionUpdate = "USER_REQUIRED_ACTION_UPDATE",
    WebhooksUpdate = "WEBHOOKS_UPDATE",
    InteractionCreate = "INTERACTION_CREATE",
    InteractionSuccess = "INTERACTION_SUCCESS",
    InteractionFailure = "INTERACTION_FAILURE",
    VoiceStateUpdate = "VOICE_STATE_UPDATE",
    VoiceServerUpdate = "VOICE_SERVER_UPDATE",
    ApplicationCommandCreate = "APPLICATION_COMMAND_CREATE",
    ApplicationCommandUpdate = "APPLICATION_COMMAND_UPDATE",
    ApplicationCommandDelete = "APPLICATION_COMMAND_DELETE",
    SessionsReplace = "SESSIONS_REPLACE",
    ThreadCreate = "THREAD_CREATE",
    ThreadUpdate = "THREAD_UPDATE",
    ThreadDelete = "THREAD_DELETE",
    ThreadListSync = "THREAD_LIST_SYNC",
    ThreadMemberUpdate = "THREAD_MEMBER_UPDATE",
    ThreadMembersUpdate = "THREAD_MEMBERS_UPDATE",
}

export type EVENT =
    | "READY"
    | "OAUTH2_TOKEN_CREATE"
    | "OAUTH2_TOKEN_DELETE"
    | "USER_APPLICATION_UPDATE"
    | "USER_APPLICATION_REMOVE"
    | "CHANNEL_CREATE"
    | "CHANNEL_UPDATE"
    | "CHANNEL_DELETE"
    | "CHANNEL_PINS_UPDATE"
    | "CHANNEL_RECIPIENT_ADD"
    | "CHANNEL_RECIPIENT_REMOVE"
    | "GUILD_CREATE"
    | "GUILD_UPDATE"
    | "GUILD_DELETE"
    | "GUILD_BAN_ADD"
    | "GUILD_BAN_REMOVE"
    | "GUILD_EMOJIS_UPDATE"
    | "GUILD_STICKERS_UPDATE"
    | "GUILD_SOUNDBOARD_SOUND_CREATE"
    | "GUILD_SOUNDBOARD_SOUND_UPDATE"
    | "GUILD_SOUNDBOARD_SOUND_DELETE"
    | "GUILD_SOUNDBOARD_SOUNDS_UPDATE"
    | "SOUNDBOARD_SOUNDS"
    | "VOICE_CHANNEL_EFFECT_SEND"
    | "GUILD_INTEGRATIONS_UPDATE"
    | "GUILD_MEMBER_ADD"
    | "GUILD_MEMBER_REMOVE"
    | "GUILD_MEMBER_UPDATE"
    | "GUILD_MEMBER_SPEAKING"
    | "GUILD_MEMBERS_CHUNK"
    | "GUILD_MEMBER_LIST_UPDATE"
    | "GUILD_ROLE_CREATE"
    | "GUILD_ROLE_DELETE"
    | "GUILD_ROLE_UPDATE"
    | "INVITE_CREATE"
    | "INVITE_DELETE"
    | "MESSAGE_CREATE"
    | "MESSAGE_UPDATE"
    | "MESSAGE_DELETE"
    | "MESSAGE_DELETE_BULK"
    | "MESSAGE_POLL_VOTE_ADD"
    | "MESSAGE_POLL_VOTE_REMOVE"
    | "MESSAGE_REACTION_ADD"
    // TODO: add a new event: bulk add reaction:
    // | "MESSAGE_REACTION_BULK_ADD"
    | "MESSAGE_REACTION_REMOVE"
    | "MESSAGE_REACTION_REMOVE_ALL"
    | "MESSAGE_REACTION_REMOVE_EMOJI"
    | "PRESENCE_UPDATE"
    | "TYPING_START"
    | "USER_UPDATE"
    | "USER_DELETE"
    | "USER_CONNECTIONS_UPDATE"
    | "USER_REQUIRED_ACTION_UPDATE"
    | "USER_NOTE_UPDATE"
    | "SAVED_MESSAGE_CREATE"
    | "SAVED_MESSAGE_DELETE"
    | "WEBHOOKS_UPDATE"
    | "INTERACTION_CREATE"
    | "INTERACTION_SUCCESS"
    | "INTERACTION_FAILURE"
    | "INTERACTION_MODAL_CREATE"
    | "EMBEDDED_ACTIVITY_UPDATE_V2"
    | "APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE"
    | "GUILD_APPLICATION_COMMAND_INDEX_UPDATE"
    | "APPLICATION_COMMAND_PERMISSIONS_UPDATE"
    | "VOICE_STATE_UPDATE"
    | "VOICE_SERVER_UPDATE"
    | "STREAM_CREATE"
    | "STREAM_SERVER_UPDATE"
    | "STREAM_DELETE"
    | "STREAM_UPDATE"
    | "CALL_CREATE"
    | "CALL_UPDATE"
    | "CALL_DELETE"
    | "VOICE_CHANNEL_STATUS_UPDATE"
    | "VOICE_CHANNEL_START_TIME_UPDATE"
    | "STAGE_INSTANCE_CREATE"
    | "STAGE_INSTANCE_UPDATE"
    | "STAGE_INSTANCE_DELETE"
    | "GUILD_SCHEDULED_EVENT_CREATE"
    | "GUILD_SCHEDULED_EVENT_UPDATE"
    | "GUILD_SCHEDULED_EVENT_DELETE"
    | "GUILD_SCHEDULED_EVENT_USER_ADD"
    | "GUILD_SCHEDULED_EVENT_USER_REMOVE"
    | "GUILD_SCHEDULED_EVENT_EXCEPTION_CREATE"
    | "GUILD_SCHEDULED_EVENT_EXCEPTION_UPDATE"
    | "GUILD_SCHEDULED_EVENT_EXCEPTION_DELETE"
    | "APPLICATION_COMMAND_CREATE"
    | "APPLICATION_COMMAND_UPDATE"
    | "APPLICATION_COMMAND_DELETE"
    | "MESSAGE_ACK"
    | "RECENT_MENTION_DELETE"
    | "RELATIONSHIP_ADD"
    | "RELATIONSHIP_REMOVE"
    | "RELATIONSHIP_UPDATE"
    | "SESSIONS_REPLACE"
    | "USER_SETTINGS_PROTO_UPDATE"
    | "USER_GUILD_SETTINGS_UPDATE"
    | "THREAD_CREATE"
    | "THREAD_UPDATE"
    | "THREAD_DELETE"
    | "THREAD_LIST_SYNC"
    | "THREAD_MEMBER_UPDATE"
    | "THREAD_MEMBERS_UPDATE"
    | "STAGE_INSTANCE_CREATE"
    | "STAGE_INSTANCE_UPDATE"
    | "STAGE_INSTANCE_DELETE"
    | "AUTO_MODERATION_RULE_CREATE"
    | "AUTO_MODERATION_RULE_UPDATE"
    | "AUTO_MODERATION_RULE_DELETE"
    | "AUTO_MODERATION_ACTION_EXECUTION"
    | "AUTO_MODERATION_MENTION_RAID_DETECTION"
    | "GUILD_JOIN_REQUEST_CREATE"
    | "GUILD_JOIN_REQUEST_UPDATE"
    | "GUILD_JOIN_REQUEST_DELETE"
    | CUSTOMEVENTS;

export type CUSTOMEVENTS =
    | "INVALIDATED"
    | "RATELIMIT"
    | "SB_SESSION_REMOVE"
    | "SB_SESSION_CLOSE"
    | "SB_GUILD_CACHE_INVALIDATE"
    | "E2EE_DEVICES_UPDATE"
    | "E2EE_IDENTITY_UPDATE"
    | "E2EE_TRUST_UPDATE"
    | "CHANNEL_E2EE_UPDATE"
    | "E2EE_LINK_REQUEST"
    | "E2EE_LINK_RESPONSE";
