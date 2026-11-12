import { User } from "@spacebar/database";
import { Config, DiscordApiErrors } from "@spacebar/util";
import { arrangeBadges, badgeSettings, isStaffBadge } from "./badgeSettings";
import { milestones, milestoneProgress } from "./milestones";
import { localProfileBadges } from "./remoteBadges";

export const DIRECTORY_STAFF_BADGE_ID = 22;

type ProfileBadge = Awaited<ReturnType<typeof localProfileBadges>>[number] & { link?: string };
type BadgeOwner = Pick<User, "id" | "badge_ids" | "federated_instance" | "pride_badges" | "account_preferences" | "created_at">;

const assetUrl = (asset: string) => `${(Config.get().cdn.endpointPublic || Config.get().api.endpointPublic || "").replace(/\/$/, "")}/${asset}`;
const iconUrl = (icon: string) => `${(Config.get().cdn.endpointPublic || Config.get().api.endpointPublic || "").replace(/\/$/, "")}/badge-icons/${icon}.png`;

export const directoryBadge = (badge: ProfileBadge, hidden: boolean, owner?: Partial<BadgeOwner>) => {
    const state = milestones[badge.id] ? milestoneProgress(badge.id, owner) : null;
    const icon = state?.current?.icon ?? state?.definition.tiers[0]?.icon ?? badge.icon;
    const dates = state?.dates ?? {};
    const selectedArt = state?.current ?? state?.definition.tiers[0];
    const remaining = state?.target ? Math.ceil(state.target.requirements[0].threshold - state.amount) : 0;
    return {
        badge_id: isStaffBadge(badge) ? DIRECTORY_STAFF_BADGE_ID : state ? state.definition.badge_id : badge.id,
        name: state?.definition.name ?? badge.description,
        description: state?.definition.leveling_instructions ?? badge.description,
        owned: state ? !!state.current : true,
        hidden,
        is_earnable: !!state?.eligible,
        simple_icon_url: iconUrl(icon),
        simple_icon_raster_url: iconUrl(icon),
        info_label: state?.summary ?? null,
        complex_icon_static_url: selectedArt ? assetUrl(selectedArt.complex_icon_static_url) : null,
        complex_icon_animated_url: selectedArt?.complex_icon_animated_url ? assetUrl(selectedArt.complex_icon_animated_url) : null,
        link: badge.link ?? null,
        tiers:
            state?.definition.tiers.map(({ icon, requirement_description, ...tier }, index) => ({
                ...tier,
                owned: index <= state.selected,
                milestone_text: requirement_description,
                simple_icon_url: assetUrl(tier.simple_icon_url),
                simple_icon_raster_url: assetUrl(tier.simple_icon_raster_url),
                complex_icon_static_url: assetUrl(tier.complex_icon_static_url),
                complex_icon_animated_url: tier.complex_icon_animated_url ? assetUrl(tier.complex_icon_animated_url) : null,
            })) ?? [],
        current_tier: state?.current?.key ?? null,
        next_tier: state?.target?.key ?? null,
        leveling_instructions: state?.definition.leveling_instructions ?? null,
        requirements: [],
        progress: state?.target
            ? [
                  {
                      current: state.amount,
                      floor: state.current?.requirements[0].threshold ?? 0,
                      threshold: state.target.requirements[0].threshold,
                      progress_helper_text: `${remaining.toLocaleString("en-GB")} more ${remaining === 1 ? state.units.slice(0, -1) : state.units}`,
                  },
              ]
            : [],
        obtained_at: state ? (dates[state.definition.tiers[0].key] ?? null) : null,
        tier_obtained_at: state ? dates : null,
    };
};

export async function badgeDirectory(user: BadgeOwner, includeHidden: boolean) {
    const { visible, hidden } = arrangeBadges(await localProfileBadges(user), badgeSettings(user));
    const owned = [...visible, ...hidden];
    const locked = includeHidden
        ? Object.entries(milestones)
              .filter(([id]) => !owned.some((badge) => badge.id === id))
              .map(([id, definition]) => ({ id, description: definition.name, icon: definition.tiers[0].icon }))
        : [];
    return [
        ...visible.map((badge) => directoryBadge(badge, false, user)),
        ...(includeHidden ? hidden.map((badge) => directoryBadge(badge, true, user)) : []),
        ...locked.map((badge) => directoryBadge(badge, false, user)),
    ];
}

export async function loadBadgeOwner(userId: string, viewerId: string) {
    const id = userId === "@me" ? viewerId : userId;
    if (!/^\d{1,20}$/.test(id)) throw DiscordApiErrors.UNKNOWN_USER;
    const user = await User.findOne({
        where: { id },
        select: { id: true, badge_ids: true, federated_instance: true, pride_badges: true, account_preferences: true, created_at: true },
    });
    if (!user) throw DiscordApiErrors.UNKNOWN_USER;
    return { user, self: user.id === viewerId };
}
