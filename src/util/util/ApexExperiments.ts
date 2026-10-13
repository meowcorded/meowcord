import murmur from "murmurhash-js/murmurhash3_gc";
import { Config } from "./Config";

export const SCHEDULED_MESSAGE_LIMIT = 25;
export const SAVED_MESSAGE_LIMIT = 500;
export const MESSAGE_REMINDER_LIMIT = 100;

const defaults: Record<string, { variant: number; config?: object }> = {
    "2026-08-scheduled-messages": { variant: 1, config: { limit: SCHEDULED_MESSAGE_LIMIT } },
    "2026-03-message-bookmarks": { variant: 1 },
    "2026-07-message-bookmarks-v2": {
        variant: 1,
        config: { b: SAVED_MESSAGE_LIMIT, r: MESSAGE_REMINDER_LIMIT },
    },
    "2026-08-mark-channel-unread": { variant: 1 },
    "2026-03-soundmoji-rendering": { variant: 1 },
    "2026-03-soundmoji-sending": { variant: 2 },
    "2026-09-soundboard-favorites": { variant: 2 },
    "2026-03-friend-request-message": { variant: 1 },
    "2026-09-connected-thread-sidebar": { variant: 1 },
    "2026-03-arborium-highlight": { variant: 1 },
    "2026-04_server_theme": { variant: 1, config: { enabled: true, inExperiment: true, gatesApex: false, rollbackEnabled: false } },
};

export const ROLLOUT_BUCKETS = 10000;
export const rolloutBucket = (name: string, userId: string) => murmur(`${name}:${userId}`) % ROLLOUT_BUCKETS;
export const inRollout = (name: string, userId: string, percent: number) => rolloutBucket(name, userId) < Math.round(percent * (ROLLOUT_BUCKETS / 100));

export type ApexAssignment = [number, number, number, number, number, string | undefined];

const assign = (name: string, variant: number, config?: object): ApexAssignment => [murmur(name), variant, 0, 1, variant, config ? JSON.stringify(config) : undefined];

export function getApexExperiments(userId?: string) {
    if (!userId) return { assignments: {} };
    const client = Config.get().client;
    const rolled: Record<string, number> = {};
    for (const [name, rollout] of Object.entries(client.rolloutExperiments ?? {})) if (inRollout(name, userId, rollout.percent)) rolled[name] = rollout.variant;
    const overrides = { ...rolled, ...client.experiments, ...client.userExperiments?.[userId] };
    const assignments: ApexAssignment[] = [];
    for (const name of new Set([...Object.keys(defaults), ...Object.keys(overrides)])) {
        const variant = Number(overrides[name] ?? defaults[name]?.variant);
        if (!Number.isInteger(variant) || variant <= 0) continue;
        assignments.push(assign(name, variant, defaults[name]?.config));
    }
    return { assignments: { 1: { [userId]: { evaluation_id: null, assignments } } } };
}

const userExperimentDefaults: Record<string, number> = {
    "2023-09_iar_user_reporting": 1,
};

export type UserExperimentAssignment = [number, number, number, number, number, number, number, number];

export function getUserExperiments(userId?: string): UserExperimentAssignment[] {
    if (!userId) return [];
    return Object.entries(userExperimentDefaults).map(([name, bucket]) => [murmur(name), 0, bucket, 0, 0, -1, 0, 0]);
}

export function getGuildExperiments(guildId: string) {
    const client = Config.get().client;
    const grants = { ...(client.experiments ?? {}), ...(client.guildExperiments?.[guildId] ?? {}) };
    const assignments = Object.entries(grants).flatMap(([name, variant]) => (Number.isInteger(variant) && variant > 0 ? [assign(name, variant, defaults[name]?.config)] : []));
    return assignments.length ? { evaluation_id: null, assignments } : undefined;
}
