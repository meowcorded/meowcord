import { assertIdentityNameAllowed } from "@spacebar/util/util/IdentityModeration";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Badge, Guild, InstanceBan, Member, Session, User } from "@spacebar/database";
import { broadcastUserUpdate, Collectibles, CollectibleItemType, emitEvent, emitRequiredAction, handleFile, Rights, UserUpdateEvent, Event } from "@spacebar/util";
import { AccountStandingState, AdminUserUpdateSchema, PrivateUserProjection } from "@spacebar/schemas";
import { In, Not } from "typeorm";
import { Pomelo, resolveProfileCollectibles, currentStanding, hasAdminPanelAccess, notifyStandingDrop, syncStaffBadge } from "@spacebar/api/util";
import { ADMIN_USER_COLUMNS, applyUserTag, pickAdminUser } from "../index";

const router = Router({ mergeParams: true });

const loadUser = (id: string) =>
    User.findOneOrFail({
        where: { id },
        select: Object.fromEntries(
            [
                ...ADMIN_USER_COLUMNS,
                "bio",
                "premium_since",
                "pronouns",
                "banner",
                "accent_color",
                "theme_colors",
                "profile_collectibles",
                "collectibles",
                "avatar_decoration_data",
                "avatar_decoration_id",
            ].map((c) => [c, true]),
        ),
    });

router.get(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        description: "Get a user with their servers, session count and instance bans",
    }),
    async (req: Request, res: Response) => {
        const user = await loadUser(req.params.user_id as string);

        const memberships = await Member.find({
            where: { id: user.id },
            select: { guild_id: true, joined_at: true },
        });
        const guilds = memberships.length
            ? await Guild.find({
                  where: { id: In(memberships.map((m) => m.guild_id)) },
                  select: { id: true, name: true, icon: true, owner_id: true },
              })
            : [];
        const [sessions, bans] = await Promise.all([Session.count({ where: { user_id: user.id } }), InstanceBan.find({ where: { user_id: user.id } })]);

        res.json({
            ...pickAdminUser(user),
            bio: user.bio,
            premium_since: user.premium_since ?? null,
            pronouns: user.pronouns ?? "",
            banner: user.banner ?? null,
            accent_color: user.accent_color ?? null,
            theme_colors: user.theme_colors ?? null,
            avatar_decoration_sku_id: user.avatar_decoration_data?.sku_id ?? user.avatar_decoration_id ?? null,
            nameplate_sku_id: user.collectibles?.nameplate?.sku_id ?? null,
            collectibles_sku_ids: (user.profile_collectibles ?? []).map((item) => item.sku_id),
            profile_collectibles: user.profile_collectibles ?? [],
            guilds: guilds.map((g) => ({
                id: g.id,
                name: g.name,
                icon: g.icon ?? null,
                owner: g.owner_id === user.id,
            })),
            session_count: sessions,
            instance_bans: bans.map((b) => ({ id: b.id, reason: b.reason, created_at: b.created_at })),
        });
    },
);

router.patch(
    "/",
    route({
        right: "MANAGE_USERS",
        spacebarOnly: true,
        requestBody: "AdminUserUpdateSchema",
        description: "Edit a user. Changing rights, or editing an operator, requires OPERATOR.",
    }),
    async (req: Request, res: Response) => {
        const body = req.body as AdminUserUpdateSchema;
        const user = await loadUser(req.params.user_id as string);
        const callerIsOperator = req.rights.has("OPERATOR");
        const targetIsOperator = new Rights(user.rights).has("OPERATOR");
        const isSelf = user.id === req.user_id;
        const hadAdminAccess = hasAdminPanelAccess(user.rights);

        if (targetIsOperator && !callerIsOperator && !isSelf) throw new HTTPError("Only operators can edit other operators", 403);
        if (isSelf && (body.disabled || body.account_standing === AccountStandingState.SUSPENDED)) throw new HTTPError("You can't disable or suspend your own account", 400);

        // only some columns are loaded, and the entity has class-level defaults (system, mfa_enabled, ...) for the rest,
        // so save() would write those defaults over the real values. Only the columns this request changes get written
        if (body.username !== undefined && body.username.trim() !== user.username) assertIdentityNameAllowed(body.username);
        assertIdentityNameAllowed(body.global_name, "global_name");

        const changed = new Set<keyof User>();

        if (body.rights !== undefined) {
            if (!callerIsOperator) throw new HTTPError("Only operators can change rights", 403);
            if (!/^\d+$/.test(body.rights)) throw new HTTPError("rights must be a decimal bitfield string", 400);
            if (isSelf && !new Rights(body.rights).has("OPERATOR")) throw new HTTPError("You can't remove OPERATOR from yourself", 400);
            user.rights = body.rights;
            changed.add("rights");
        }

        const set = <K extends keyof User>(key: K, value: User[K]) => {
            user[key] = value;
            changed.add(key);
        };

        if (body.hide_premium_badge !== undefined) set("hide_premium_badge", body.hide_premium_badge);
        const standingBefore = body.account_standing !== undefined ? await currentStanding(user.id) : null;
        if (body.account_standing !== undefined) set("account_standing", body.account_standing);
        if (body.tag !== undefined) {
            applyUserTag(user, body.tag);
            changed.add("public_flags").add("flags");
        }
        if (body.badge_ids !== undefined) {
            const ids = [...new Set(body.badge_ids)];
            const known = ids.length ? await Badge.find({ where: { id: In(ids) }, select: { id: true } }) : [];
            const unknown = ids.filter((id) => !known.some((b) => b.id === id));
            if (unknown.length) throw new HTTPError(`Unknown badge: ${unknown.join(", ")}`, 400);
            set("badge_ids", ids);
        }
        if (body.username !== undefined && body.username.trim() !== user.username) {
            const username = body.username.trim();
            if (username.length < 2) throw new HTTPError("Username must contain at least two characters", 400);
            if (!user.bot) User.assertUsernameAllowed(username);
            if (user.discriminator === "0") Pomelo.validate(username);
            if (
                await User.exists({
                    where: { username, discriminator: user.discriminator, id: Not(user.id) },
                })
            )
                throw new HTTPError("This username is already in use", 400);
            set("username", username);
        }
        if (body.avatar_decoration_sku_id !== undefined) {
            const item = body.avatar_decoration_sku_id ? await Collectibles.item(body.avatar_decoration_sku_id, CollectibleItemType.AVATAR_DECORATION) : null;
            if (body.avatar_decoration_sku_id && !item?.asset) throw new HTTPError("Choose an existing avatar decoration", 400);
            set("avatar_decoration_id", undefined);
            set("avatar_decoration_data", item ? { asset: item.asset!, sku_id: item.sku_id, expires_at: null } : undefined);
        }
        if (body.nameplate_sku_id !== undefined) {
            const item = body.nameplate_sku_id ? await Collectibles.item(body.nameplate_sku_id, CollectibleItemType.NAMEPLATE) : null;
            if (body.nameplate_sku_id && !item?.asset) throw new HTTPError("Choose an existing nameplate", 400);
            set("collectibles", {
                ...user.collectibles,
                nameplate: item
                    ? {
                          sku_id: item.sku_id,
                          asset: item.asset!,
                          label: item.label ?? "",
                          palette: item.palette ?? "",
                          expires_at: null,
                      }
                    : null,
            });
        }
        if (body.collectibles_sku_ids && body.collectibles_sku_ids.length > 2) throw new HTTPError("Choose at most one profile effect and one frame", 400);
        if (body.collectibles_sku_ids !== undefined) set("profile_collectibles", await resolveProfileCollectibles(user.profile_collectibles, body.collectibles_sku_ids));
        if (body.pronouns !== undefined) set("pronouns", body.pronouns);
        if (body.accent_color !== undefined) set("accent_color", body.accent_color ?? undefined);
        if (body.theme_colors !== undefined) {
            if (body.theme_colors && (body.theme_colors.length !== 2 || body.theme_colors.some((color) => !Number.isInteger(color) || color < 0 || color > 16777215)))
                throw new HTTPError("Theme colors must be integers between 0 and 16777215", 400);
            set("theme_colors", body.theme_colors ?? undefined);
        }
        for (const field of ["avatar", "banner"] as const) {
            if (body[field] !== undefined) set(field, body[field] ? await handleFile(`/${field}s/${user.id}`, body[field]!) : undefined);
        }
        if (body.global_name !== undefined) {
            set("global_name", body.global_name?.trim() || null);
        }
        if (body.bio !== undefined) set("bio", body.bio);
        if (body.disabled !== undefined) set("disabled", body.disabled);
        if (body.verified !== undefined) set("verified", body.verified);
        if (body.premium_type !== undefined) {
            if (body.premium_type > 0 && !user.premium_type) set("premium_since", new Date());
            set("premium_type", body.premium_type);
            set("premium", body.premium_type > 0);
        }

        if (body.rights !== undefined) {
            await syncStaffBadge(user, hadAdminAccess);
            changed.add("badge_ids");
        }

        if (changed.size) await User.update({ id: user.id }, Object.fromEntries([...changed].map((key) => [key, user[key] ?? null])));

        if (user.disabled || user.account_standing === AccountStandingState.SUSPENDED) {
            const sessions = await Session.find({
                where: { user_id: user.id },
                select: { session_id: true },
            });
            await Session.delete({ user_id: user.id });
            await Promise.all(
                sessions.map((session) =>
                    emitEvent({
                        session_id: session.session_id,
                        event: "SB_SESSION_REMOVE",
                        origin: "Account suspended",
                    } as Event),
                ),
            );
        }

        if (standingBefore !== null) await notifyStandingDrop(user.id, standingBefore, await currentStanding(user.id));

        const updated = await User.findOneOrFail({
            where: { id: user.id },
            select: Object.fromEntries(PrivateUserProjection.map((i) => [i, true])),
        });
        await emitEvent({
            event: "USER_UPDATE",
            user_id: user.id,
            data: updated,
        } satisfies UserUpdateEvent);

        if (changed.has("verified")) await emitRequiredAction(user.id);
        if (changed.size) await broadcastUserUpdate(user.id);
        res.json(pickAdminUser(await loadUser(user.id)));
    },
);

export default router;
