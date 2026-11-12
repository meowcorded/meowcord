import { readFileSync } from "node:fs";
import path from "node:path";
import type { User } from "@spacebar/database";
import { ASSETS_FOLDER } from "@spacebar/util";

export interface ActivityProgress {
    played_ms: number;
    streamed_ms: number;
    games: string[];
    last_credit: number;
    awards: Record<string, string>;
}

export type MilestoneOwner = Pick<User, "account_preferences"> & Partial<Pick<User, "created_at">>;

export interface MilestoneTier {
    key: string;
    name: string;
    icon: string;
    rarity?: number;
    requirement_description: string;
    simple_icon_url: string;
    simple_icon_raster_url: string;
    complex_icon_static_url: string;
    complex_icon_animated_url?: string;
    requirements: { threshold: number; unit?: string; progress_type?: number }[];
}

export interface Milestone {
    badge_id: number;
    name: string;
    metric: "played_ms" | "streamed_ms" | "games" | "account_years";
    tiers: MilestoneTier[];
    leveling_instructions: string;
}

export const milestones: Record<string, Milestone> = JSON.parse(readFileSync(path.join(ASSETS_FOLDER, "milestones.json"), "utf8"));

export function monthMark(start: Date, months: number) {
    const date = new Date(start);
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const end = new Date(date);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    date.setUTCDate(Math.min(start.getUTCDate(), end.getUTCDate()));
    return date;
}

export function elapsedMonths(start: Date | undefined, now: Date) {
    if (!start || !Number.isFinite(start.getTime()) || start > now) return 0;
    let months = (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + now.getUTCMonth() - start.getUTCMonth();
    if (monthMark(start, months) > now) months--;
    const floor = monthMark(start, months).getTime();
    return months + (now.getTime() - floor) / (monthMark(start, months + 1).getTime() - floor);
}

export function milestoneProgress(id: string, owner?: MilestoneOwner, now = new Date()) {
    const definition = milestones[id];
    const activity = owner?.account_preferences?.activity_progress;
    const date = definition.metric === "account_years" ? owner?.created_at : undefined;
    const amount =
        definition.metric === "games"
            ? (activity?.games.length ?? 0)
            : definition.metric === "account_years"
              ? elapsedMonths(date, now) / 12
              : (activity?.[definition.metric] ?? 0) / 3600000;
    const actual = definition.tiers.findLastIndex((tier) => tier.requirements[0].threshold <= amount);
    const selected = actual;
    const current = definition.tiers[selected];
    const target = definition.tiers[selected + 1];
    const units = definition.metric === "games" ? "games" : definition.metric === "account_years" ? "years" : "hours";
    const summary =
        definition.metric === "games"
            ? `${amount}${amount >= 100 ? "+" : ""} games played`
            : definition.metric === "account_years"
              ? `${Math.floor(amount)} years, ${Math.floor(amount * 12) % 12} months`
              : `${Math.floor(amount).toLocaleString("en-GB")}${amount >= 5000 ? "+" : ""} ${Math.floor(amount) === 1 ? "hour" : "hours"} ${id === "19" ? "streamed to others" : "of games played"}`;
    const dates = Object.fromEntries(
        definition.tiers.slice(0, actual + 1).flatMap((tier) => {
            const threshold = tier.requirements[0].threshold;
            const value = date ? monthMark(date, threshold * (units === "years" ? 12 : 1)).toISOString() : activity?.awards[`${id}:${threshold}`];
            return value ? [[tier.key, value]] : [];
        }),
    );
    return { definition, activity, amount, eligible: true, selected, current, target, units, summary, dates };
}

export function earnedMilestoneBadges(owner?: MilestoneOwner) {
    return Object.keys(milestones).flatMap((id) => {
        const { definition, current } = milestoneProgress(id, owner);
        return current ? [{ id, description: `${definition.name} · ${current.name}`, icon: current.icon }] : [];
    });
}
