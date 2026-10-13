export interface GuildProfileTrait {
    label: string;
    position: number;
    emoji_id?: string | null;
    emoji_name?: string | null;
    emoji_animated?: boolean | null;
}

export interface GuildProfileSettings {
    tag?: string | null;
    badge?: number | null;
    badge_color_primary?: string | null;
    badge_color_secondary?: string | null;
    badge_hash?: string | null;
    traits?: GuildProfileTrait[];
    brand_color_primary?: string | null;
    visibility?: number;
    custom_banner_hash?: string | null;
    game_application_ids?: string[];
}

export interface GuildThemeCustomSettings {
    colors: string[];
    gradient_color_stops?: (number | { color: string; stop: number } | any)[];
    gradient_angle?: number;
    base_mix?: number;
}

export interface GuildTheme {
    preset_id: number | null;
    custom_user_theme_settings: GuildThemeCustomSettings | null;
    enabled: boolean;
}

export interface GuildThemeModifySchema {
    preset_id?: number | null;
    custom_user_theme_settings?: GuildThemeCustomSettings | null;
    enabled: boolean;
}

export interface GuildProfileModifySchema {
    name?: string;
    description?: string | null;
    icon?: string | null;
    custom_banner?: string | null;
    visibility?: number;
    brand_color_primary?: string | null;
    traits?: (GuildProfileTrait | null)[];
    game_application_ids?: string[];
    tag?: string | null;
    badge?: number | null;
    badge_color_primary?: string | null;
    badge_color_secondary?: string | null;
}

export interface GuildEmojiReference {
    id?: string | null;
    name?: string | null;
    animated?: boolean | null;
}

export interface GuildHomeSettings {
    guild_id?: string;
    enabled: boolean;
    welcome_message: { author_ids: string[]; message: string };
    new_member_actions: {
        channel_id: string;
        action_type: number;
        title: string;
        description: string;
        emoji?: GuildEmojiReference | null;
        icon?: string | null;
    }[];
    resource_channels: {
        channel_id: string;
        title: string;
        description?: string;
        emoji?: GuildEmojiReference | null;
        icon?: string | null;
    }[];
}

export interface GuildOnboardingPromptOption {
    id: string;
    channel_ids: string[];
    role_ids: string[];
    emoji?: GuildEmojiReference | null;
    emoji_id?: string | null;
    emoji_name?: string | null;
    emoji_animated?: boolean | null;
    title: string;
    description?: string | null;
}

export interface GuildOnboardingPrompt {
    id: string;
    type: number;
    options: GuildOnboardingPromptOption[];
    title: string;
    single_select: boolean;
    required: boolean;
    in_onboarding: boolean;
    disabled?: boolean;
}

export interface GuildOnboarding {
    guild_id?: string;
    prompts: GuildOnboardingPrompt[];
    default_channel_ids: string[];
    enabled: boolean;
    mode: number;
    below_requirements?: boolean;
    responses?: string[];
    onboarding_prompts_seen?: Record<string, number>;
    onboarding_responses_seen?: Record<string, number>;
}

export interface GuildMemberVerificationFormField {
    field_type: string;
    label: string;
    description?: string | null;
    automations?: unknown[] | null;
    required: boolean;
    values?: string[] | null;
    choices?: string[] | null;
    response?: unknown;
    placeholder?: string | null;
}

export interface GuildMemberVerification {
    version: string;
    form_fields: GuildMemberVerificationFormField[];
    description: string | null;
}

export interface GuildMemberVerificationModifySchema {
    enabled?: boolean;
    form_fields?: GuildMemberVerificationFormField[];
    description?: string | null;
    bulk_action?: "APPROVED" | "REJECTED";
}

export interface GuildJoinRequestActionSchema {
    action: "APPROVED" | "REJECTED";
    /**
     * @maxLength 160
     */
    rejection_reason?: string | null;
}

export interface GuildJoinRequestBulkActionSchema {
    action: "APPROVED" | "REJECTED";
}

export interface GuildDiscoveryMetadata {
    primary_category_id: number;
    keywords: string[] | null;
    emoji_discoverability_enabled: boolean;
    partner_actioned_timestamp: string | null;
    partner_application_timestamp: string | null;
    is_published: boolean;
    reasons_to_join: { reason: string; emoji_id?: string | null; emoji_name?: string | null }[];
    social_links: string[] | null;
    about: string | null;
    category_ids?: number[];
}
