import { In } from "typeorm";
import { Badge, User } from "@spacebar/database";
import {
    federationMediaUrl,
    instanceName,
    loadStaffRoles,
    MAX_REMOTE_BADGE_DESCRIPTION,
    MAX_REMOTE_BADGES,
    readStoredBadges,
    RemoteBadge,
    remoteBadgeTooltip,
    sanitizeRemoteBadges,
    staffBadgeRole,
    WireBadge,
} from "@spacebar/util";
import { arrangeBadges, badgeSettings } from "./badgeSettings";
import { federatedInstance, homeCdnBase } from "./federationMedia";
import { PRIDE_BADGES, prideBadges } from "./prideBadges";
import { earnedMilestoneBadges, milestones } from "./milestones";
import { isSubscriptionBadge } from "./profile";
import { ensureStaffBadge, STAFF_BADGE_ID } from "./staffBadge";

export const PRIDE_FLAGS: ReadonlySet<string> = new Set(PRIDE_BADGES.map((badge) => badge.slug));
const RESERVED_TTL = 60_000;
type Reserved = { ids: Set<string>; icons: Set<string> };
let reserved: { at: number; value: Promise<Reserved> } | null = null;

const localBadges = () => {
    if (!reserved || Date.now() - reserved.at > RESERVED_TTL) {
        const value = Badge.find({ select: { id: true, icon: true } }).then((rows) => ({
            ids: new Set(rows.map((row) => row.id)),
            icons: new Set([...rows.map((row) => row.icon), ...PRIDE_BADGES.map((badge) => badge.icon as string)]),
        }));
        reserved = { at: Date.now(), value };
        value.catch(() => {
            reserved = null;
        });
    }
    return reserved.value;
};

type BadgeSource = Pick<User, "id" | "badge_ids" | "pride_badges" | "federated_instance" | "account_preferences"> & Partial<Pick<User, "created_at">>;

export async function localProfileBadges(user: BadgeSource) {
    const shadow = !!user.federated_instance;
    const ids = (user.badge_ids ?? []).filter((id) => !milestones[id] && (!shadow || id !== STAFF_BADGE_ID));
    const badges: { id: string; description: string; icon: string; link?: string }[] = ids.length ? await Badge.find({ where: { id: In(ids) } }) : [];
    const role = shadow || user.badge_ids?.includes(STAFF_BADGE_ID) ? null : staffBadgeRole(user.id, await loadStaffRoles());
    if (role) {
        const staffBadge = await ensureStaffBadge();
        badges.unshift({ id: `staff-role-${role.id}`, description: `${instanceName()} ${role.name}`, icon: staffBadge.icon, link: staffBadge.link });
    }
    badges.push(...prideBadges(user.pride_badges));
    return [...badges.filter((badge) => !isSubscriptionBadge(badge)), ...(!shadow ? earnedMilestoneBadges(user) : [])];
}

export async function homeBadges(user_id: string): Promise<WireBadge[]> {
    const user = await User.findOne({
        where: { id: user_id },
        select: { id: true, badge_ids: true, pride_badges: true, federated_instance: true, account_preferences: true, created_at: true },
    });
    if (!user || user.federated_instance) return [];
    const cdn = homeCdnBase();
    if (!cdn) return [];
    const pride = new Map(PRIDE_BADGES.map((badge) => [badge.id as string, badge.slug as string]));
    const wire: WireBadge[] = [];
    for (const badge of arrangeBadges(await localProfileBadges(user), badgeSettings(user)).visible) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(badge.icon)) continue;
        const flag = pride.get(badge.id);
        const role = badge.id.startsWith("staff-role-");
        const id = flag ? `pride-${flag}` : role ? `role-${badge.id.slice("staff-role-".length)}` : `badge-${badge.id}`;
        wire.push({
            id: id.slice(0, 64),
            description: badge.description.slice(0, MAX_REMOTE_BADGE_DESCRIPTION),
            icon: `${cdn}/badge-icons/${badge.icon}.png`,
            ...(flag && { pride_flag: flag }),
            ...((role || badge.id === STAFF_BADGE_ID) && { staff: true }),
        });
        if (wire.length >= MAX_REMOTE_BADGES) break;
    }
    return wire;
}

export async function cleanRemoteBadges(instance: string, raw: unknown) {
    const source = await federatedInstance(instance);
    if (!source) return [];
    const { ids, icons } = await localBadges();
    return sanitizeRemoteBadges(raw, { origin: source.url, prideFlags: PRIDE_FLAGS, reserved: (id) => ids.has(id), reservedIcon: (icon) => icons.has(icon) });
}

export async function storeRemoteBadges(local_id: string, instance: string, raw: unknown) {
    const badges = await cleanRemoteBadges(instance, raw);
    const row = await User.findOne({ where: { id: local_id }, select: { id: true, federated_instance: true, remote_badges: true } });
    if (!row || row.federated_instance !== instance) return;
    if (JSON.stringify(row.remote_badges ?? null) === JSON.stringify(badges)) return;
    await User.update({ id: local_id }, { remote_badges: badges });
}

export interface RemoteBadgeView {
    id: string;
    kind: RemoteBadge["kind"];
    description: string;
    label: string | null;
    icon_url: string | null;
}

export function remoteBadgeView(instance: string, stored: unknown): RemoteBadgeView[] {
    const cdn = homeCdnBase();
    const pride = new Map(PRIDE_BADGES.map((badge) => [badge.slug as string, badge]));
    return readStoredBadges(stored, PRIDE_FLAGS).map((badge, index) => {
        const flag = badge.kind === "pride" ? pride.get(badge.pride_flag!) : undefined;
        const description = flag ? flag.description : badge.description;
        return {
            id: `remote-${index}`,
            kind: badge.kind,
            description: remoteBadgeTooltip({ kind: badge.kind, description }, instance),
            label: badge.kind === "staff" ? `Staff on ${instance}` : null,
            icon_url: flag
                ? `${cdn}/badge-icons/${flag.icon}.png`
                : badge.kind === "badge" && badge.icon
                  ? federationMediaUrl(cdn, instance, `/badge-icons/${badge.icon}.png`)
                  : null,
        };
    });
}
