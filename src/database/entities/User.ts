import { assertIdentityNameAllowed } from "@spacebar/util/util/IdentityModeration";
import { assertMaxLength, UserFieldCaps } from "@spacebar/util/util/UserFieldCaps";
import { readAvatarCornerRadius, withAvatarCornerRadius } from "@spacebar/util/util/AvatarCornerRadius";
import { Request } from "express";
import { AfterLoad, Column, Entity, FindOptionsWhere, ILike, Index, IsNull, JoinColumn, ManyToOne, OneToMany, OneToOne } from "typeorm";
import { Config, Email, FieldErrors, Snowflake } from "@spacebar/util";
import { Stopwatch, trimSpecial, Random } from "@spacebar/extensions";
import { BaseClass } from "./BaseClass";
import { sqlReturning } from "../Sql";
import { AvatarDecoration } from "./AvatarDecoration";
import { Channel } from "./Channel";
import { ConnectedAccount } from "./ConnectedAccount";
import { Member } from "./Member";
import { Relationship } from "./Relationship";
import { SecurityKey } from "./SecurityKey";
import { Session } from "./Session";
import { UserSettings } from "./UserSettings";
import {
    AvatarDecorationData,
    ChannelType,
    Collectibles,
    DisplayNameStyle,
    PartialUser,
    PrimaryGuild,
    PrivateUserProjection,
    ProfileCollectible,
    RecentAvatar,
    PublicUser,
    PublicUserProjection,
    UserFlags,
    UserGuildSettings,
    UserPrivate,
} from "@spacebar/schemas";
import { JsonNumber } from "@spacebar/util/util/Decorators";

export type JoinStatus = "pending" | "approved" | "rejected";

export interface AccountPreferences {
    consents?: Record<string, boolean>;
    email_categories?: Record<string, boolean>;
    email_settings_initialized?: boolean;
    notification_flags?: number;
    activity_progress?: { played_ms: number; streamed_ms: number; games: string[]; last_credit: number; awards: Record<string, string> };
    badge_settings?: { display_order?: string[]; hidden_badges?: string[] };
    harvest?: HarvestRecord;
}

export interface ProfileWidget {
    id: string;
    data: { type: string; [key: string]: string | number | boolean | null | object };
}

export interface HarvestRecord {
    harvest_id: string;
    user_id: string;
    email: string;
    state: string;
    status: number;
    created_at: string;
    completed_at: string | null;
    polled_at: string | null;
    updated_at: string;
    backends: Record<string, string>;
    shadow_run: boolean;
    harvest_metadata: {
        user_is_staff: boolean;
        sla_email_sent: boolean;
        bypass_cooldown: boolean;
        is_provisional: boolean;
    };
}

@Entity({
    name: "users",
})
export class User extends BaseClass {
    @Column()
    username: string; // username max length 32, min 2 (should be configurable)

    @Column()
    discriminator: string; // opaque string: 4 digits on discord.com

    @Column({ type: String, nullable: true })
    global_name?: string | null;

    @Column({ nullable: true })
    avatar?: string; // hash of the user avatar

    @Column({ nullable: true })
    accent_color?: number; // banner color of user

    @Column({ nullable: true })
    banner?: string; // hash of the user banner

    // TODO: Separate `User` and `UserProfile` models
    // puyo: changed from [number, number] because it breaks openapi
    @Column({ nullable: true, type: "int4", array: true })
    theme_colors?: number[];

    @Column({ nullable: true })
    pronouns?: string;

    @Column({ nullable: true, select: false, type: String })
    phone?: string | null; // phone number of the user

    @Column({ select: false })
    desktop: boolean = false; // if the user has desktop app installed

    @Column({ select: false })
    mobile: boolean = false; // if the user has mobile app installed

    @Column()
    premium: boolean; // if user bought individual premium

    @Column()
    premium_type: number; // individual premium level

    @Column()
    bot: boolean = false; // if user is bot

    @Column()
    bio: string = ""; // short description of the user

    @Column()
    system: boolean = false; // shouldn't be used, the api sends this field type true, if the generated message comes from a system generated author

    @Column({ select: false })
    nsfw_allowed: boolean = true; // if the user can do age-restricted actions (NSFW channels/guilds/commands) // TODO: depending on age

    @Column({ select: false })
    mfa_enabled: boolean = false; // if multi factor authentication is enabled

    @Column({ select: false, default: false })
    webauthn_enabled: boolean = false; // if webauthn multi factor authentication is enabled

    @Column({ select: false, nullable: true })
    totp_secret?: string = "";

    @Column({ nullable: true, select: false })
    totp_last_ticket?: string = "";

    @Column()
    created_at: Date; // registration date

    @Column({ nullable: true })
    premium_since: Date; // premium date

    @Column({ select: false })
    verified: boolean; // email is verified

    @Column()
    disabled: boolean = false; // if the account is disabled

    @Column()
    deleted: boolean = false; // if the user was deleted

    @Column({ default: false })
    hide_premium_badge: boolean = false; // admin-controlled: keeps premium, just leaves the badge off their profile

    // staff override for the account standing page (AccountStandingState); null works it out from violations
    @Column({ type: "int", nullable: true })
    account_standing?: number | null;

    @Column({ type: "timestamptz", nullable: true, select: false })
    suspended_until?: Date | null;

    @Column({ type: "text", nullable: true, select: false })
    join_reason?: string | null;

    @Column({ type: "varchar", nullable: true, select: false })
    join_status?: JoinStatus | null;

    @Column({ nullable: true, select: false })
    email?: string; // email of the user

    @Column({ type: "bigint" })
    @JsonNumber
    flags: number = 0; // UserFlags // TODO: generate

    @Column({ type: "bigint" })
    @JsonNumber
    public_flags: number = 0;

    @Column({ type: "bigint" })
    @JsonNumber
    purchased_flags: number = 0;

    @Column()
    premium_usage_flags: number = 0;

    @Column({ type: "bigint" })
    @JsonNumber
    rights: string;

    @OneToMany(
        () => Session,
        (session: Session) => session.user,
    )
    sessions: Session[];

    @JoinColumn({ name: "relationship_ids", foreignKeyConstraintName: "FK_user_relationship_ids" })
    @OneToMany(
        () => Relationship,
        (relationship: Relationship) => relationship.from,
        {
            cascade: true,
            orphanedRowAction: "delete",
        },
    )
    relationships: Relationship[];

    @JoinColumn({
        name: "connected_account_ids",
        foreignKeyConstraintName: "FK_user_connected_account_ids",
    })
    @OneToMany(
        () => ConnectedAccount,
        (account: ConnectedAccount) => account.user,
        {
            cascade: true,
            orphanedRowAction: "delete",
        },
    )
    connected_accounts: ConnectedAccount[];

    @Column({ type: "jsonb", select: false })
    data: {
        valid_tokens_since: Date; // all tokens with a previous issue date are invalid
        hash?: string; // hash of the password, salt is saved in password (bcrypt)
    };

    @Column({ type: "varchar", array: true, select: false })
    fingerprints: string[] = []; // array of fingerprints -> used to prevent multiple accounts

    @Index("IDX_users_registration_ip")
    @Column({ type: String, nullable: true, select: false })
    registration_ip?: string | null;

    @OneToOne(() => UserSettings, {
        cascade: true,
        orphanedRowAction: "delete",
        nullable: true,
    })
    @JoinColumn({ foreignKeyConstraintName: "FK_user_settings_index" })
    settings?: UserSettings;

    @OneToMany(
        () => SecurityKey,
        (key: SecurityKey) => key.user,
    )
    security_keys: SecurityKey[];

    @Column({ type: "int8", array: true, nullable: true })
    badge_ids?: string[];

    @Column({ type: "jsonb", nullable: true })
    avatar_decoration_data?: AvatarDecorationData;

    @Column({ type: "jsonb", nullable: true })
    display_name_styles?: DisplayNameStyle;

    @Column({ type: "jsonb", nullable: true })
    collectibles?: Collectibles;

    @Column({ type: "jsonb", nullable: true })
    primary_guild?: PrimaryGuild;

    @Column({ type: "jsonb", nullable: true })
    profile_collectibles?: ProfileCollectible[] | null;

    @Column({ type: "jsonb", nullable: true, select: false })
    recent_avatars?: RecentAvatar[] | null;

    @Column({ type: "jsonb", nullable: true, select: false })
    account_preferences?: AccountPreferences | null;

    @Column({ type: "jsonb", nullable: true, select: false })
    private_channel_settings?: UserGuildSettings | null;

    @Column({ type: "text", array: true, default: "{}", select: false })
    pride_badges?: string[];

    @Column({ type: "jsonb", nullable: true })
    profile_widgets?: ProfileWidget[] | null;

    @Column({ type: "int", nullable: true })
    avatar_corner_radius?: number | null;

    @JoinColumn({
        name: "avatar_decoration_id",
        foreignKeyConstraintName: "FK_user_avatar_decoration_id",
    })
    @OneToOne(() => AvatarDecoration, { onDelete: "SET NULL", nullable: true })
    avatar_decoration?: AvatarDecoration;

    @Column({ type: "int8", nullable: true })
    avatar_decoration_id?: string;

    @Column({ type: "varchar", nullable: true })
    federated_instance?: string | null;

    @Column({ type: "jsonb", nullable: true, select: false })
    remote_badges?: { id: string; kind: string; description: string; pride_flag?: string; icon?: string }[] | null;

    @AfterLoad()
    applyPremiumDefaults() {
        const { premium, premiumType } = Config.get().defaults.user;
        if (!premium || this.bot || this.premium_type === undefined || this.premium_type >= premiumType) return;
        // the instance's own system accounts (official, appeals) never get premium
        if (this.system || BigInt(this.flags ?? 0) & UserFlags.FLAGS.SYSTEM) return;
        this.premium_type = premiumType;
        if (this.premium !== undefined) this.premium = true;
        this.premium_since ??= this.created_at;
    }

    // TODO: I don't like this method?
    validate() {
        if (this.discriminator && this.discriminator !== "0") {
            const discrim = Number(this.discriminator);
            if (isNaN(discrim) || !Number.isInteger(discrim) || discrim <= 0 || discrim >= 10000)
                throw FieldErrors({
                    discriminator: {
                        message: "Discriminator must be a number.",
                        code: "DISCRIMINATOR_INVALID",
                    },
                });

            this.discriminator = discrim.toString().padStart(4, "0");
        }
    }

    toPublicUser() {
        this.clean_data();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const user: any = {};
        PublicUserProjection.forEach((x) => {
            user[x] = this[x];
        });

        if (this.avatar_decoration) (<PublicUser>user).avatar_decoration_data = this.avatar_decoration.toJSON();

        return withAvatarCornerRadius(user, this.avatar_corner_radius) as PublicUser;
    }

    toPartialUser(): PartialUser {
        return {
            id: this.id,
            username: this.username,
            discriminator: this.discriminator,
            global_name: this.global_name ?? null,
            avatar: this.avatar ?? null,
            avatar_decoration_data: this.avatar_decoration
                ? {
                      ...this.avatar_decoration?.toJSON(),
                      ...this.avatar_decoration_data,
                  }
                : (this.avatar_decoration_data ?? null),
            collectibles: this.collectibles ?? null,
            display_name_styles: this.display_name_styles ?? null,
            primary_guild: this.primary_guild ?? null,
            bot: this.bot,
            system: this.system,
            banner: this.banner,
            accent_color: this.accent_color,
            public_flags: Number(this.public_flags),
            ...(readAvatarCornerRadius(this.avatar_corner_radius) !== null && { avatar_corner_radius: this.avatar_corner_radius }),
        } satisfies PartialUser;
    }

    toPrivateUser(extraFields: (keyof User)[] = []) {
        this.clean_data();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const user: any = {};
        [...PrivateUserProjection, ...extraFields].forEach((x) => {
            user[x] = this[x];
        });

        if (this.avatar_decoration) (<UserPrivate>user).avatar_decoration_data = this.avatar_decoration.toJSON();
        user.nsfw_allowed = true;
        user.age_verification_status = 3;

        return withAvatarCornerRadius(user, this.avatar_corner_radius, true) as UserPrivate;
    }

    static async setAccountPreferences(id: string, values: Partial<AccountPreferences>) {
        const entries = Object.entries(values).filter(([, value]) => value !== undefined);
        if (!entries.length) return;
        if (User.getRepository().manager.connection.options.type === "postgres") {
            await User.query(`UPDATE users SET account_preferences = COALESCE(account_preferences, '{}'::jsonb) || $1::jsonb WHERE id = $2`, [
                JSON.stringify(Object.fromEntries(entries)),
                id,
            ]);
            return;
        }
        await User.query(`UPDATE users SET account_preferences = json_set(COALESCE(account_preferences, '{}'), ${entries.map(() => "?, json(?)").join(", ")}) WHERE id = ?`, [
            ...entries.flatMap(([key, value]) => [`$.${key}`, JSON.stringify(value)]),
            id,
        ]);
    }

    static async setHarvest(id: string, harvest: HarvestRecord, replacing: { harvest_id: string } | { pending_since: string; previous_id: string | null }) {
        const postgres = User.getRepository().manager.connection.options.type === "postgres";
        const field = (key: string) => (postgres ? `account_preferences->'harvest'->>'${key}'` : `CAST(json_extract(account_preferences, '$.harvest.${key}') AS text)`);
        const condition =
            "harvest_id" in replacing
                ? `${field("harvest_id")} = $3`
                : `NOT (COALESCE(${field("status")}, '') IN ('0', '1') AND COALESCE(${field("updated_at")}, '') > $3) AND COALESCE(${field("harvest_id")}, '') = $4`;
        const merged = postgres
            ? `COALESCE(account_preferences, '{}'::jsonb) || jsonb_build_object('harvest', CAST($1 AS jsonb))`
            : `json_set(COALESCE(account_preferences, '{}'), '$.harvest', json($1))`;
        const rows = (await User.query(
            sqlReturning(`UPDATE users SET account_preferences = ${merged} WHERE id = $2 AND ${condition} RETURNING id`),
            "harvest_id" in replacing ? [JSON.stringify(harvest), id, replacing.harvest_id] : [JSON.stringify(harvest), id, replacing.pending_since, replacing.previous_id ?? ""],
        )) as unknown[];
        return rows.length > 0;
    }

    static async getPublicUser(user_id: string): Promise<PublicUser> {
        const user = await User.findOneOrFail({
            where: { id: user_id },
            select: Object.fromEntries(PublicUserProjection.map((i) => [i, true])), // TODO: clean up
        });
        return user.toPublicUser();
    }

    public static async generateDiscriminator(username: string): Promise<string | undefined> {
        if (Config.get().register.incrementingDiscriminators) {
            // discriminator will be incrementally generated

            // First we need to figure out the currently highest discrimnator for the given username and then increment it
            const users = await User.find({
                where: { username },
                select: { discriminator: true },
            });
            const highestDiscriminator = Math.max(0, ...users.map((u) => Number(u.discriminator)));

            const discriminator = highestDiscriminator + 1;
            if (discriminator >= 10000) {
                return undefined;
            }

            return discriminator.toString().padStart(4, "0");
        } else {
            // discriminator will be randomly generated

            // randomly generates a discriminator between 1 and 9999 and checks max five times if it already exists
            // TODO: is there any better way to generate a random discriminator only once, without checking if it already exists in the database?
            const takenDiscriminators = (await User.find({ where: { username }, select: { discriminator: true } })).map((x) => x.discriminator);
            if (takenDiscriminators.length >= 9999) return undefined;

            for (let tries = 0; tries < 15; tries++) {
                const discriminator = Random.nextInt(1, 9999).toString().padStart(4, "0");
                if (!takenDiscriminators.includes(discriminator)) return discriminator;
            }

            return undefined;
        }
    }

    static isValidPomeloUsername(username: string) {
        return /^[a-z0-9_.]{2,32}$/i.test(username) && !username.includes("..");
    }

    static loginWhere(login: string): FindOptionsWhere<User>[] {
        const tag = login.match(/^(.+)#(\d{4})$/);
        return [
            { phone: login, federated_instance: IsNull() },
            { email: login, federated_instance: IsNull() },
            {
                username: ILike((tag?.[1] ?? login).replace(/[\\%_]/g, "\\$&")),
                discriminator: tag?.[2] ?? "0",
                bot: false,
                federated_instance: IsNull(),
            },
        ];
    }

    static isUsernameBlacklisted(username: string) {
        const name = username.trim().toLowerCase();
        return (Config.get().register.blacklistedUsernames ?? []).some((entry) => {
            const pattern = entry.trim().toLowerCase();
            if (!pattern) return false;
            if (!pattern.includes("*")) return pattern === name;
            return new RegExp(
                `^${pattern
                    .split("*")
                    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join(".*")}$`,
            ).test(name);
        });
    }

    /** Throws the error the client shows under the username field when the instance has blacklisted the name. */
    static assertUsernameAllowed(username: string) {
        assertIdentityNameAllowed(username);
        if (User.isUsernameBlacklisted(username))
            throw FieldErrors({
                username: {
                    code: "USERNAME_BLACKLISTED",
                    message: `Cannot use '${username.trim()}'. This username is blacklisted from registering.`,
                },
            });
    }

    static async isUsernameTaken(username: string, exceptUserId?: string) {
        const query = User.createQueryBuilder("u").where("LOWER(u.username) = LOWER(:username)", { username }).andWhere("u.bot = false");
        if (exceptUserId) query.andWhere("u.id != :id", { id: exceptUserId });
        return (await query.getCount()) > 0;
    }

    static async suggestUsername(source: string, exceptUserId?: string) {
        const base =
            source
                .toLowerCase()
                .normalize("NFKD")
                .replace(/[^a-z0-9_.]/g, "")
                .replace(/\.{2,}/g, ".")
                .slice(0, 26) || "user";
        const padded = base.length < 2 ? `${base}_` : base;
        if (!(await User.isUsernameTaken(padded, exceptUserId))) return padded;
        for (let tries = 0; tries < 20; tries++) {
            const candidate = `${padded}${Random.nextInt(0, 9999).toString().padStart(4, "0")}`;
            if (!(await User.isUsernameTaken(candidate, exceptUserId))) return candidate;
        }
        return `${padded}${Date.now().toString(36)}`;
    }

    public get tag(): string {
        return this.discriminator === "0" ? this.username : `${this.username}#${this.discriminator}`;
    }

    static async register({
        email,
        username,
        password,
        id,
        req,
        bot,
        global_name,
        pride_badges,
        registration_ip,
    }: {
        registration_ip?: string | null;
        username: string;
        global_name?: string;
        pride_badges?: string[];
        password?: string;
        email?: string;
        date_of_birth?: Date; // "2000-04-03"
        id?: string;
        req?: Request;
        bot?: boolean;
    }) {
        const totalSw = Stopwatch.startNew();
        const incSw = Stopwatch.startNew();
        const logTrace = (...data: unknown[]) => {
            if (process.env.LOG_VERBOSE_TRACES !== "true") return;
            console.log("[User.register]", ...data, `[${totalSw.elapsed().toString()} (+${incSw.getElapsedAndReset().totalMilliseconds}ms)]`);
        };

        // trim special utf8 control characters -> Backspace, Newline, ...
        username = trimSpecial(username);

        assertMaxLength("global_name", global_name, UserFieldCaps.globalName);
        assertIdentityNameAllowed(username);
        assertIdentityNameAllowed(global_name, "global_name");
        if (!bot) User.assertUsernameAllowed(username);
        if (!bot && (await User.isUsernameTaken(username)))
            throw FieldErrors({
                username: {
                    code: "USERNAME_ALREADY_TAKEN",
                    message: "Username is unavailable. Try adding numbers, letters, underscores _ , or periods.",
                },
            });

        const discriminator = bot ? await User.generateDiscriminator(username) : "0";
        if (!discriminator) {
            // We've failed to generate a valid and unused discriminator
            throw FieldErrors({
                username: {
                    code: "USERNAME_TOO_MANY_USERS",
                    message: req?.t("auth:register.USERNAME_TOO_MANY_USERS") || "",
                },
            });
        }
        logTrace("Generate discriminator");

        // TODO: save date_of_birth
        // apparently discord doesn't save the date of birth and just calculate if nsfw is allowed
        // if nsfw_allowed is null/undefined it'll require date_of_birth to set it to true/false
        const language = req?.language === "en" ? "en-US" : req?.language || "en-US";

        const settings = UserSettings.create({
            locale: language,
        });

        const user = User.create({
            username: username,
            discriminator,
            global_name: global_name?.trim() || null,
            id: id || Snowflake.generate(),
            email: email,
            data: {
                hash: password,
                valid_tokens_since: new Date(),
            },
            settings: settings,

            premium_since: Config.get().defaults.user.premium ? new Date() : undefined,
            rights: Config.get().register.defaultRights,
            premium: Config.get().defaults.user.premium ?? false,
            premium_type: Config.get().defaults.user.premiumType ?? 0,
            verified: Config.get().defaults.user.verified ?? true,
            created_at: new Date(),
            bot: !!bot,
            pride_badges: [...new Set(pride_badges ?? [])],
            registration_ip: registration_ip ?? null,
        });

        user.validate();
        logTrace("Generate/validate user");

        await Promise.all([user.save(), settings.save()]);
        logTrace("Save user");

        // send verification email if users aren't verified by default and we have an email
        if (!Config.get().defaults.user.verified && email) {
            await Email.sendVerifyEmail(user, email).catch((e) => {
                console.error(`Failed to send verification email to ${user.tag}: ${e}`);
            });
            logTrace("Send verify email");
        }

        const { autoJoin } = Config.get().guild;
        if (autoJoin.enabled && autoJoin.guilds.length > 0 && !(bot && !autoJoin.bots)) {
            await Promise.all(autoJoin.guilds.map((guild) => Member.addToGuild(user.id, guild, true).catch((e) => console.error("[Autojoin]", e))));
            logTrace("Autojoin", autoJoin.guilds.length, "guilds");
        }

        return user;
    }

    async getDmChannelWith(user_id: string) {
        const qry = await Channel.getRepository()
            .createQueryBuilder()
            .innerJoin("Channel.recipients", "rcp")
            .where("Channel.type = :type", { type: ChannelType.DM })
            .andWhere("rcp.user_id IN (:...user_ids)", { user_ids: [this.id, user_id] })
            .groupBy("Channel.id")
            .having("COUNT(rcp.user_id) = 2")
            .getMany();

        // Emma [it/its]@Rory&: is this technically a bug, or am I being too over-cautious?
        if (qry.length > 1) {
            console.warn(`[WARN] User(${this.id})#getDmChannel(${user_id}) returned multiple channels:`);
            for (const channel of qry) {
                console.warn(JSON.stringify(channel));
            }
            throw new Error("Array contains more than one matching element");
        }

        return qry[0];
    }

    async getDmChannels() {
        const qry = await Channel.getRepository()
            .createQueryBuilder("channel")
            .leftJoinAndSelect("channel.recipients", "rcp")
            .where("channel.type = :type", { type: ChannelType.DM })
            .andWhere("rcp.user_id = :user_id", { user_id: this.id })
            .groupBy("channel.id")
            .addGroupBy("rcp.id")
            .having("COUNT(rcp.id) = 2")
            .getMany();

        return qry;
    }
}
