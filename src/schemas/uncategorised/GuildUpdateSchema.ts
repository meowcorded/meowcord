import { GuildCreateSchema, GuildTheme } from "@spacebar/schemas";

export interface GuildUpdateSchema extends Omit<GuildCreateSchema, "channels" | "system_channel_id" | "rules_channel_id"> {
    /**
     * @pattern ^[0-9]{1,20}$
     */
    owner_id?: string;
    banner?: string | null;
    splash?: string | null;
    description?: string | null;
    system_channel_id?: string | null;
    rules_channel_id?: string | null;
    features?: string[];
    verification_level?: number;
    default_message_notifications?: number;
    system_channel_flags?: number;
    explicit_content_filter?: number;
    public_updates_channel_id?: string | null;
    afk_timeout?: number;
    afk_channel_id?: string | null;
    preferred_locale?: string;
    premium_progress_bar_enabled?: boolean;
    discovery_splash?: string | null;
    safety_alerts_channel_id?: string | null;
    theme?: GuildTheme | null;
}
