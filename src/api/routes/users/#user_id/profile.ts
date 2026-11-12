import { Request, Response, Router } from "express";
import { In } from "typeorm";
import { route } from "@spacebar/api/middlewares";
import { authenticatorTypes, ensureStaffBadge, profileMetadata, resolveProfileCollectibles, STAFF_BADGE_ID } from "@spacebar/api/util";
import { Badge, Member, Relationship, User } from "@spacebar/database";
import { broadcastUserUpdate, Config, DiscordApiErrors, emitEvent, FieldErrors, handleFile, instanceName, loadStaffRoles, staffBadgeRole, UserUpdateEvent } from "@spacebar/util";
import { PartialConnectedAccountResponse, PrivateUserProjection, PublicUserProjection, RelationshipType, UserProfileModifySchema } from "@spacebar/schemas";

import { prideBadges } from "@spacebar/api/util/utility/prideBadges";

import { isSubscriptionBadge } from "@spacebar/api/util/utility/profile";
import { arrangeBadges, badgeSettings } from "@spacebar/api/util/utility/badgeSettings";

import { profileApplication } from "@spacebar/api/util/handlers/Application";

const router: Router = Router({ mergeParams: true });

router.get("/", route({ responses: { 200: { body: "UserProfileResponse" } } }), async (req: Request, res: Response) => {
    if (req.params.user_id === "@me") req.params.user_id = req.user_id;

    const { with_mutual_guilds, with_mutual_friends, with_mutual_friends_count } = req.query as Record<string, string | undefined>;
    const guild_id = req.query.guild_id;
    if (guild_id !== undefined) {
        if (typeof guild_id !== "string" || !/^\d{1,20}$/.test(guild_id))
            throw FieldErrors({
                guild_id: {
                    code: "BASE_TYPE_BAD_FORMAT",
                    message: "Guild ID must be a snowflake",
                },
            });
        await Member.IsInGuildOrFail(req.user_id, guild_id);
    }
    const { user_id } = req.params as { [key: string]: string };

    const user = await User.createQueryBuilder("user")
        .leftJoin("user.connected_accounts", "connected_accounts")
        .addSelect([
            "connected_accounts.id",
            "connected_accounts.type",
            "connected_accounts.name",
            "connected_accounts.verified",
            "connected_accounts.metadata_",
            "connected_accounts.metadata_visibility",
            "connected_accounts.visibility",
        ])
        .addSelect("user.pride_badges")
        .addSelect("user.account_preferences")
        .leftJoinAndSelect("user.avatar_decoration", "avatar_decoration")
        .where("user.id = :user_id", { user_id })
        .getOneOrFail();

    let mutual_guilds: { id: string; nick: string | null }[] | undefined;
    if (with_mutual_guilds === "true") {
        mutual_guilds = [];
        if (user_id !== req.user_id) {
            const [memberships, ownMemberships] = await Promise.all([
                Member.find({ where: { id: user_id }, select: { guild_id: true, nick: true } }),
                Member.find({ where: { id: req.user_id }, select: { guild_id: true } }),
            ]);
            const own = new Set(ownMemberships.map((member) => member.guild_id));
            mutual_guilds = memberships.filter((member) => own.has(member.guild_id)).map((member) => ({ id: member.guild_id, nick: member.nick ?? null }));
        }
    }

    let mutual_friends;
    let mutual_friends_count;
    if (with_mutual_friends === "true" || with_mutual_friends_count === "true") {
        let mutualIds: string[] = [];
        if (user_id !== req.user_id) {
            const [mine, theirs] = await Promise.all(
                [req.user_id, user_id].map((from_id) =>
                    Relationship.find({
                        where: { from_id, type: RelationshipType.FRIEND },
                        select: { to_id: true },
                    }),
                ),
            );
            const theirIds = new Set(theirs.map((x) => x.to_id));
            mutualIds = mine.map((x) => x.to_id).filter((x) => theirIds.has(x));
        }
        mutual_friends_count = mutualIds.length;
        if (with_mutual_friends === "true")
            mutual_friends = mutualIds.length
                ? (
                      await User.find({
                          where: { id: In(mutualIds) },
                          select: Object.fromEntries(PublicUserProjection.map((i) => [i, true])),
                      })
                  ).map((u) => u.toPartialUser())
                : [];
    }

    const guild_member = guild_id
        ? await Member.findOne({
              where: { id: user_id, guild_id },
              relations: { roles: true },
          })
        : null;

    const badges = [];
    const badgeIds = (user.badge_ids ?? []).filter((id) => !user.federated_instance || id !== STAFF_BADGE_ID);
    if (badgeIds.length) badges.push(...(await Badge.find({ where: { id: In(badgeIds) } })));
    const badgeRole = user.federated_instance || user.badge_ids?.includes(STAFF_BADGE_ID) ? null : staffBadgeRole(user.id, await loadStaffRoles());
    if (badgeRole) {
        const staffBadge = await ensureStaffBadge();
        badges.unshift(Badge.create({ id: `staff-role-${badgeRole.id}`, description: `${instanceName()} ${badgeRole.name}`, icon: staffBadge.icon, link: staffBadge.link }));
    }

    badges.push(...prideBadges(user.pride_badges));

    const connected_accounts: PartialConnectedAccountResponse[] = user.connected_accounts
        .filter((x) => x.visibility != 0)
        .map((x) => ({
            id: x.id,
            type: x.type,
            name: x.name,
            verified: x.verified ?? false,
            ...(x.metadata_visibility != 0 && x.metadata_ ? { metadata: x.metadata_ } : {}),
        }));

    res.json({
        user: { ...user.toPartialUser(), bio: user.bio ?? "" },
        connected_accounts,
        premium_since: null,
        premium_type: user.premium_type,
        premium_guild_since: null,
        profile_themes_experiment_bucket: 4,
        user_profile: profileMetadata(user),
        badges: arrangeBadges(
            badges.filter((badge) => !isSubscriptionBadge(badge)),
            badgeSettings(user),
        ).visible,
        guild_badges: [],
        widgets: user.profile_widgets ?? [],
        legacy_username: null,
        ...(user.bot ? { application: await profileApplication(user.id) } : {}),
        ...(mutual_guilds ? { mutual_guilds } : {}),
        ...(mutual_friends ? { mutual_friends } : {}),
        ...(mutual_friends_count !== undefined ? { mutual_friends_count } : {}),
        ...(guild_member
            ? {
                  guild_member: {
                      ...guild_member.toPublicMember(),
                      roles: guild_member.roles.filter((x) => x.id !== guild_id).map((x) => x.id),
                      user: user.toPartialUser(),
                  },
                  guild_member_profile: profileMetadata(guild_member),
              }
            : {}),
    });
});

router.patch("/", route({ requestBody: "UserProfileModifySchema" }), async (req: Request, res: Response) => {
    if (![req.user_id, "@me"].includes(`${req.params.user_id}`)) throw DiscordApiErrors.MISSING_ACCESS;
    const body = req.body as UserProfileModifySchema;

    const user = await User.findOneOrFail({
        where: { id: req.user_id },
        select: Object.fromEntries([...PrivateUserProjection, "profile_collectibles"].map((i) => [i, true])),
        relations: { avatar_decoration: true },
    });
    const publicBefore = JSON.stringify(user.toPublicUser());

    const { maxBio, maxPronouns } = Config.get().limits.user;
    if (body.bio && body.bio.length > maxBio)
        throw FieldErrors({
            bio: {
                code: "BIO_INVALID",
                message: `Bio must be less than ${maxBio} in length`,
            },
        });
    if (body.pronouns && body.pronouns.length > maxPronouns)
        throw FieldErrors({
            pronouns: {
                code: "PRONOUNS_INVALID",
                message: `Pronouns must be less than ${maxPronouns} in length`,
            },
        });

    if (body.bio !== undefined) user.bio = body.bio ?? "";
    if (body.pronouns !== undefined) Object.assign(user, { pronouns: body.pronouns || null });
    if (body.accent_color !== undefined) Object.assign(user, { accent_color: body.accent_color });
    if (body.theme_colors !== undefined) Object.assign(user, { theme_colors: body.theme_colors });
    if (body.banner !== undefined)
        Object.assign(user, {
            banner: body.banner ? await handleFile(`/banners/${req.user_id}`, body.banner) : null,
        });

    if (body.collectibles_sku_ids !== undefined || body.profile_effect_id !== undefined)
        user.profile_collectibles = await resolveProfileCollectibles(user.profile_collectibles, body.collectibles_sku_ids, body.profile_effect_id);

    await user.save();

    await emitEvent({
        event: "USER_UPDATE",
        user_id: req.user_id,
        data: { ...user.toPrivateUser(), authenticator_types: await authenticatorTypes(req.user_id) },
    } as unknown as UserUpdateEvent);
    if (JSON.stringify(user.toPublicUser()) !== publicBefore) await broadcastUserUpdate(req.user_id);

    res.json(profileMetadata(user));
});

export default router;
