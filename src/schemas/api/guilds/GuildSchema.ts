import { Snowflake } from "../../Identifiers";

export interface GuildAvailableSchema {
    id: Snowflake;
    available: boolean;
}

export interface IntegrationGuild {
    id: Snowflake;
    name: string;
    icon: string | null;
}

export enum GuildVerificationLevel {
    NONE = 0,
    // Verified email
    LOW = 1,
    // Registered >5min ago
    MEDIUM = 2,
    // Member for >10min
    HIGH = 3,
    // Verified phone number
    VERY_HIGH = 4,
}

export enum GuildNsfwLevel {
    DEFAULT = 0,
    EXPLICIT = 1,
    SAFE = 2,
    AGE_RESTRICTED = 3,
}

// Unlocked boost perk level
export enum GuildPremiumTier {
    NONE = 0,
    TIER_1 = 1,
    TIER_2 = 2,
    TIER_3 = 3,
}

export enum GuildHubType {
    DEFAULT = 0,
    HIGH_SCHOOL = 1,
    COLLEGE = 2,
}

export enum GuildMFALevel {
    NONE = 0,
    ELEVATED = 1,
}

export interface GuildMfaSchema {
    level: GuildMFALevel;
}

export interface GuildMfaResponse {
    level: GuildMFALevel;
}
