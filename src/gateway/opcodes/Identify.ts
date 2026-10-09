import { In } from "typeorm";
import { PreloadedUserSettings } from "discord-protos";
import { Capabilities, CLOSECODES, genSessionId, getGuildCache, OPCODES, Payload, Send, setupListener, WebSocket } from "@spacebar/gateway";
import { arrayGroupBy, ElapsedTime, Stopwatch, timeFunction, timePromise } from "@spacebar/extensions";
import {
    getDatabase,
    Application,
    Channel,
    Guild,
    GuildJoinRequest,
    Member,
    MemberPrivateProjection,
    ReadState,
    Recipient,
    Relationship,
    Role,
    SecurityKey,
    Session,
    ThreadMember,
    StageInstance,
    User,
    ScheduledEvents,
    UserSettings,
    UserSettingsProtos,
    userGuildSettingsEntry,
    VoiceState,
    PrivateCalls,
    ActivityInstances,
    RateLimit,
} from "@spacebar/database";
import {
    Activity,
    broadcastPresence,
    emitSessionsReplace,
    sanitizeActivities,
    getClientPlatform,
    getConnectedSessions,
    getUserPresences,
    PRESENCE_STALE_AFTER_MS,
    checkToken,
    Config,
    requiredAction,
    Rights,
    CurrentTokenFormatVersion,
    emitEvent,
    EVENTEnum,
    generateToken,
    GuildOrUnavailable,
    Intents,
    OPCodes,
    OrmUtils,
    ReadyEventData,
    ReadyGuildDTO,
    GUILD_VERSION_HORIZON,
    GuildEntityDelete,
    ReadyUserGuildSettingsEntries,
    SessionsReplace,
    TraceNode,
    TraceRoot,
    getApexExperiments,
    getGuildExperiments,
} from "@spacebar/util";
import {
    ChannelType,
    DefaultUserGuildSettings,
    DMChannel,
    IdentifySchema,
    PrivateStatus,
    PrivateUserProjection,
    PublicUser,
    PublicMember,
    PublicMemberProjection,
    PublicUserProjection,
    RelationshipType,
} from "@spacebar/schemas";
import { check } from "./instanceOf";
import { openConnections } from "../events/Connection";
import { botIntentsAllowed } from "../util/GatewayIntents";

type GuildPresenceMember = Omit<PublicMember, "user">;

// TODO: user sharding
// TODO: check privileged intents, if defined in the config

const SettableStatuses = ["online", "idle", "dnd", "invisible"];

export async function onIdentify(this: WebSocket, data: Payload) {
    const totalSw = Stopwatch.startNew();
    const taskSw = Stopwatch.startNew();
    const gatewayShardName = process.env.WORKER_NAME ?? `sb-gateway`;

    if (this.user_id) {
        // we've already identified
        return this.close(CLOSECODES.Already_authenticated);
    }

    // Check payload matches schema
    check.call(this, IdentifySchema, data.d);
    const identify: IdentifySchema = data.d;

    this.capabilities = new Capabilities(identify.capabilities || 0);
    const prioritizedReady = this.capabilities.has(Capabilities.FLAGS.PRIORITIZED_READY_PAYLOAD);
    this.large_threshold = identify.large_threshold || 250;
    const parseAndValidateTime = taskSw.getElapsedAndReset();

    const { result: tokenData, elapsed: checkTokenTime } = await timePromise(() =>
        checkToken(identify.token, {
            // relations: {"relationships", "relationships.to", "settings"],
            // select: [...PrivateUserProjection, "relationships", "rights"],
            select: [...PrivateUserProjection, "rights"],
        }),
    );

    if (this.readyState !== this.OPEN) return;
    this.accessToken = identify.token;

    taskSw.reset(); // don't include checkToken time...

    const user = tokenData.user;
    if (!user) {
        console.log(`[Gateway/${this.ipAddress}] Failed to identify user`);
        return this.close(CLOSECODES.Authentication_failed);
    }

    const { enabled, identify: identifyLimit } = Config.get().limits.rate;
    if (enabled && !new Rights(user.rights).has("BYPASS_RATE_LIMITS")) {
        const max = user.bot ? (identifyLimit.bot ?? identifyLimit.count) : identifyLimit.count;
        const limit = await RateLimit.hit(`${user.id}:identify`, user.id, max, identifyLimit.window);
        if (limit.hits > max) {
            console.log(`[Gateway/${user.id}] identify rate limited (${limit.hits} in ${identifyLimit.window}s)`);
            await Send(this, { op: OPCODES.Invalid_Session, d: false });
            return this.close(CLOSECODES.Rate_limited, "You are identifying too fast.");
        }
        if (this.readyState !== this.OPEN) return;
    }

    this.user_id = user.id;
    this.session = tokenData.session;
    const userQueryTime = taskSw.getElapsedAndReset();

    // Check intents
    if (identify.intents == null) identify.intents = user.bot ? 0n : 0b11011111111111111111111111111111111n;
    this.intents = new Intents(identify.intents);

    if (user.bot) {
        const [application, guildCount] = await Promise.all([Application.findOne({ where: { id: user.id }, select: { flags: true } }), Member.count({ where: { id: user.id } })]);
        if (!botIntentsAllowed(this.intents, application?.flags ?? 0, guildCount)) return this.close(CLOSECODES.Disallowed_intent);
        if (this.readyState !== this.OPEN) return;
    }

    // TODO: actually do intent things.

    // Validate sharding
    if (identify.shard) {
        this.shard_id = identify.shard[0];
        this.shard_count = identify.shard[1];

        if (this.shard_count == null || this.shard_id == null || this.shard_id >= this.shard_count || this.shard_id < 0 || this.shard_count <= 0) {
            // TODO: why do we even care about this right now?
            console.log(`[Gateway/${this.user_id}] Invalid sharding from ${user.id}: ${identify.shard}`);
            return this.close(CLOSECODES.Invalid_shard);
        }
    }
    const validateIntentsAndShardingTime = taskSw.getElapsedAndReset();

    // Generate a new gateway session if needed (id is already made, just save it in db )
    const { session, isNewSession } = tokenData.session
        ? { session: tokenData.session, isNewSession: false }
        : {
              session: Session.create({
                  user_id: this.user_id,
                  session_id: this.session_id,
                  status: "offline", // ??? why wasnt this required before
              }),
              isNewSession: true,
          };

    if (isNewSession)
        console.warn(
            "[Identify/WARN] Created new session",
            session.session_id,
            "for user",
            tokenData.user.id,
            `(${tokenData.user.tag})! - Access token version`,
            tokenData.tokenVersion,
            "- Access token session ID:",
            tokenData.decoded.did ?? "(undefined)",
        );

    if (tokenData.tokenVersion < CurrentTokenFormatVersion)
        console.warn(
            "[Identify/WARN] Access token version",
            tokenData.tokenVersion,
            "used by user",
            tokenData.user.id,
            `(${tokenData.user.tag})! - Client`,
            this.capabilities.has(Capabilities.FLAGS.AUTH_TOKEN_REFRESH) ? "did" : "did not",
            "opt for token refresh.",
        );

    this.session_id = genSessionId();
    this.session = session;

    this.pendingDispatches = [];
    this.isBot = !!user.bot;
    const listenerPromise = setupListener.call(this);
    // this.session.status = identify.presence?.status || "online";
    this.session.last_seen = new Date();
    this.session.client_info ??= {};
    // noinspection SuspiciousTypeOfGuard - typeorm being weird
    if (typeof this.session.client_info === "string") this.session.client_info = JSON.parse(this.session.client_info);
    // noinspection SuspiciousTypeOfGuard - typeorm being weird
    if (typeof this.session.last_seen_location_info === "string") this.session.last_seen_location_info = JSON.parse(this.session.last_seen_location_info);
    this.session.client_info.platform = getClientPlatform(identify.properties);
    this.session.client_info.browser = identify.properties?.browser || identify.properties?.$browser || identify.properties?.device || identify.properties?.$device;
    this.session.client_info.os = identify.properties?.os || identify.properties?.$os;

    if (this.ipAddress && this.ipAddress !== this.session.last_seen_ip) {
        this.session.last_seen_ip = this.ipAddress;
        await this.session.updateIpInfo();
    }

    const createSessionTime = taskSw.getElapsedAndReset();

    // Get from database:
    // * the users read states
    // * guild members for this user
    // * recipients ( dm channels )
    // * the bot application, if it exists
    const [
        { result: sessions, elapsed: sessionQueryTime },
        { result: relationships, elapsed: relationshipQueryTime },
        { result: settings, elapsed: settingsQueryTime },
        { result: settingsProtos, elapsed: settingsProtosQueryTime },
        { result: application, elapsed: applicationQueryTime },
        { result: read_states, elapsed: read_statesQueryTime },
        { result: members, elapsed: membersQueryTime },
        { result: recipients, elapsed: recipientsQueryTime },
    ] = await Promise.all([
        timePromise(() => getConnectedSessions(this.user_id).then((x) => x.filter((s) => s.session_id !== session.session_id))),
        timePromise(() =>
            Relationship.find({
                where: { from_id: this.user_id },
                relations: { to: true },
            }),
        ),
        timePromise(() => UserSettings.getOrDefault(this.user_id)),
        timePromise(() =>
            UserSettingsProtos.findOne({
                where: { user_id: this.user_id },
            }),
        ),
        timePromise(() =>
            Application.findOne({
                where: { id: this.user_id },
                select: { id: true, flags: true },
            }),
        ),
        timePromise(() =>
            ReadState.find({
                where: { user_id: this.user_id },
                select: {
                    id: true,
                    channel_id: true,
                    last_message_id: true,
                    last_pin_timestamp: true,
                    mention_count: true,
                },
            }),
        ),
        timePromise(async () => {
            const members: Member[] = await Member.find({
                where: { id: this.user_id },
                select: OrmUtils.keysToObject(["index", ...(<string[]>MemberPrivateProjection).filter((key) => !["guild", "roles", "user"].includes(key))]),
                order: { index: "ASC" },
            });
            if (!members.length) return members;
            const memberRoles: { index: number; roles: string[] }[] = await Member.query(
                `SELECT index, array_agg(role_id::text) AS roles FROM member_roles WHERE index = ANY($1) GROUP BY index`,
                [members.map((m) => m.index)],
            );
            const rolesByIndex = new Map(memberRoles.map((row) => [String(row.index), row.roles]));
            for (const member of members) member.roles = (rolesByIndex.get(String(member.index)) ?? []).map((id) => ({ id }) as Role);
            return members;
        }),
        timePromise(() =>
            Recipient.find({
                where: { user_id: this.user_id, closed: false },
                relations: { channel: { recipients: { user: true } } },
                select: {
                    id: true,
                    message_request_timestamp: true,
                    channel: {
                        id: true,
                        flags: true,
                        // is_spam: true,	// TODO
                        last_message_id: true,
                        last_pin_timestamp: true,
                        type: true,
                        icon: true,
                        name: true,
                        owner_id: true,
                        recipients: {
                            // we don't actually need this ID or any other information about the recipient info,
                            // but typeorm does not select anything from the users relation of recipients unless we select
                            // at least one column.
                            id: true,
                            // We only want public user data for each dm channel
                            user: Object.fromEntries(PublicUserProjection.map((x) => [x, true])),
                        },
                    },
                },
            }),
        ),
    ]);

    user.relationships = relationships;
    user.settings = settings;

    const userMetaQueryTime = taskSw.getElapsedAndReset();

    const statusSettings = settingsProtos?.userSettings?.status;
    const requestedStatus = identify.presence?.status;
    const savedStatus = statusSettings?.status?.value || settings?.status;
    this.session.status = (
        requestedStatus && SettableStatuses.includes(requestedStatus) ? requestedStatus : savedStatus && SettableStatuses.includes(savedStatus) ? savedStatus : "online"
    ) as PrivateStatus;
    const customStatus = statusSettings?.customStatus;
    const customStatusActive =
        customStatus && (customStatus.text || customStatus.emojiName) && (!Number(customStatus.expiresAtMs) || Number(customStatus.expiresAtMs) > Date.now());
    this.session.activities =
        (identify.presence?.activities ? sanitizeActivities(identify.presence.activities) : undefined) ??
        (customStatusActive
            ? [
                  {
                      name: "Custom Status",
                      type: 4,
                      state: customStatus.text || undefined,
                      emoji: customStatus.emojiName
                          ? {
                                name: customStatus.emojiName,
                                id: Number(customStatus.emojiId) ? String(customStatus.emojiId) : undefined,
                                animated: false,
                            }
                          : undefined,
                  } as Activity,
              ]
            : []);
    this.session.client_status = this.session.status === "invisible" ? {} : { [this.session.client_info.platform!]: this.session.status };
    const sessionSavePromise = timePromise(
        () => (isNewSession ? Session.insert(this.session!) : Session.update({ session_id: this.session!.session_id }, this.session!)) as Promise<unknown>,
    );

    const friendPresenceUserIds = [...new Set(relationships.filter((relationship) => relationship.type === RelationshipType.FRIEND).map((relationship) => relationship.to_id))];
    const memberGuildIds = members.map((m) => m.guild_id);

    const affinityUsers = new Map<string, User>();
    for (const relationship of relationships) if (relationship.type === RelationshipType.FRIEND && relationship.to) affinityUsers.set(relationship.to_id, relationship.to);
    for (const { channel } of recipients)
        for (const recipient of channel.recipients ?? []) if (recipient.user?.id && recipient.user.id !== this.user_id) affinityUsers.set(recipient.user.id, recipient.user);
    const affinityUserIds = [...new Set([...friendPresenceUserIds, ...affinityUsers.keys()])];
    const friendPresencePromise = timePromise(() => getUserPresences(affinityUserIds));
    const guildPresencePromise = (async () => {
        if (!memberGuildIds.length || (!user.bot && !affinityUserIds.length) || (user.bot && !this.intents.has(Intents.FLAGS.GUILD_PRESENCES)))
            return {
                guildPresenceMembers: [] as GuildPresenceMember[],
                guildPresenceMap: new Map() as Awaited<ReturnType<typeof getUserPresences>>,
                guildPresenceUsers: [] as User[],
            };
        const onlineSessions = await Session.createQueryBuilder("session")
            .select("session.user_id", "user_id")
            .distinct(true)
            .where(
                user.bot ? "session.user_id IN (SELECT m.id FROM members m WHERE m.guild_id IN (:...guildIds))" : "session.user_id IN (:...affinityUserIds)",
                user.bot ? { guildIds: memberGuildIds } : { affinityUserIds },
            )
            .andWhere("session.status NOT IN ('offline', 'invisible')")
            .andWhere("session.is_admin_session = false")
            .andWhere("session.user_id != :self", { self: this.user_id })
            .andWhere("session.last_seen > :since", {
                since: new Date(Date.now() - PRESENCE_STALE_AFTER_MS),
            })
            .limit(1000)
            .getRawMany<{ user_id: string }>();
        const onlineUserIds = onlineSessions.map((x) => x.user_id);
        const [guildPresenceMembers, guildPresenceMap, guildPresenceUsers] = await Promise.all([
            onlineUserIds.length
                ? (Member.query(
                      `SELECT ${PublicMemberProjection.filter((x) => x !== "roles")
                          .map((x) => `m."${x}"`)
                          .join(", ")}, COALESCE(array_agg(mr.role_id::text) FILTER (WHERE mr.role_id IS NOT NULL AND mr.role_id <> m.guild_id), '{}') AS roles
                       FROM members m LEFT JOIN member_roles mr ON mr.index = m.index
                       WHERE m.id = ANY($1) AND m.guild_id = ANY($2)
                       GROUP BY m.index`,
                      [onlineUserIds, memberGuildIds],
                  ) as Promise<GuildPresenceMember[]>)
                : Promise.resolve([] as GuildPresenceMember[]),
            getUserPresences(onlineUserIds),
            onlineUserIds.length
                ? User.find({
                      where: { id: In(onlineUserIds) },
                      select: Object.fromEntries(PublicUserProjection.map((x) => [x, true])),
                  })
                : Promise.resolve([] as User[]),
        ]);
        return { guildPresenceMembers, guildPresenceMap, guildPresenceUsers };
    })();

    // select relations
    const [
        { result: memberGuilds, elapsed: queryGuildsTime },
        { result: guildCache, elapsed: guildCacheTime },
        { result: memberGuildVoiceStates, elapsed: queryGuildVoiceStatesTime },
        { result: threadMembers, elapsed: threadMemberTime },
        { result: allThreadsRaw, elapsed: queryThreadsTime },
        stageInstances,
        scheduledEvents,
    ] = await Promise.all([
        timePromise(() =>
            Guild.find({
                where: { id: In(memberGuildIds) },
                select: Object.fromEntries(
                    getDatabase()!
                        .getMetadata(Guild)
                        .columns.map((x) => [x.propertyName, true]),
                ),
            }),
        ),
        timePromise(() => getGuildCache(memberGuildIds)),
        timePromise(() =>
            VoiceState.find({
                where: { guild_id: In(memberGuildIds) },
                order: { guild_id: "ASC" },
            }),
        ),
        timePromise(() =>
            ThreadMember.find({
                where: { member_idx: In(members.map(({ index }) => index)) },
            }),
        ),
        timePromise(() =>
            Channel.find({
                where: {
                    type: In([ChannelType.GUILD_NEWS_THREAD, ChannelType.GUILD_PUBLIC_THREAD, ChannelType.GUILD_PRIVATE_THREAD]),
                    guild_id: In(memberGuildIds),
                },
            }),
        ),
        memberGuildIds.length ? StageInstance.find({ where: { guild_id: In(memberGuildIds) } }) : [],
        ScheduledEvents.forGuilds(memberGuildIds),
    ]);

    const [{ elapsed: sessionSaveTime }, { result: friendPresenceMap, elapsed: friendPresenceSessionsQueryTime }, { guildPresenceMembers, guildPresenceMap, guildPresenceUsers }] =
        await Promise.all([sessionSavePromise, friendPresencePromise, guildPresencePromise]);
    const { result: friendPresences, elapsed: generateFriendPresencesTime } = timeFunction(() =>
        affinityUserIds
            .filter((id) => affinityUsers.has(id) && friendPresenceMap.has(id))
            .map((id) => ({
                user: affinityUsers.get(id)!.toPublicUser(),
                ...friendPresenceMap.get(id)!,
            })),
    );

    const guildPresenceMembersByGuild = arrayGroupBy(guildPresenceMembers, (m) => m.guild_id);
    const stageInstancesByGuild = arrayGroupBy(stageInstances, (i) => i.guild_id);
    const scheduledEventCounts = await ScheduledEvents.userCounts(scheduledEvents.map((e) => e.id));
    const scheduledEventsByGuild = arrayGroupBy(scheduledEvents, (e) => e.guild_id);
    const threadMemberMap = new Map(threadMembers.map((member) => [member.id, member] as const));
    const allThreads = allThreadsRaw.filter(({ id, thread_metadata }) => thread_metadata?.archived === false && threadMemberMap.has(id));

    const { result: voiceStatesByGuild, elapsed: groupVoiceStatesTime } = timeFunction(() => arrayGroupBy(memberGuildVoiceStates, (v) => v.guild_id!));
    const { result: threadsByGuild, elapsed: groupThreadsTime } = timeFunction(() => arrayGroupBy(allThreads, (t) => t.guild_id!));

    const queryGuildVoiceStatesTimeTotal = new ElapsedTime(queryGuildVoiceStatesTime.totalNanoseconds + groupVoiceStatesTime.totalNanoseconds);
    const queryThreadsTimeTotal = new ElapsedTime(queryThreadsTime.totalNanoseconds + groupThreadsTime.totalNanoseconds);

    const guildMap = new Map(memberGuilds.map((g) => [g.id, g]));

    const mergeMemberGuildsTrace: TraceNode = {
        micros: 0,
        calls: [],
    };

    members.forEach((m) => {
        const sw = Stopwatch.startNew();
        const totalSw = Stopwatch.startNew();
        const trace: TraceNode = {
            micros: 0,
            calls: [],
        };

        const g = guildMap.get(m.guild_id);
        if (g) {
            m.guild = g;
            trace.calls.push("findGuild", { micros: sw.getElapsedAndReset().totalMicroseconds });

            const cached = guildCache.get(m.guild_id);
            g.emojis = cached?.emojis ?? [];
            g.roles = cached?.roles ?? [];
            g.stickers = cached?.stickers ?? [];
            trace.calls.push(`getCachedGuild(${cached?.channels.length ?? 0}/${g.roles.length}/${g.emojis.length}/${g.stickers.length})`, {
                micros: sw.getElapsedAndReset().totalMicroseconds,
            });

            g.voice_states = voiceStatesByGuild.get(m.guild_id) ?? [];
            trace.calls.push(`getVoiceStates(${g.voice_states.length}/${memberGuildVoiceStates.length})`, { micros: sw.getElapsedAndReset().totalMicroseconds });

            trace.micros = totalSw.elapsed().totalMicroseconds;
            mergeMemberGuildsTrace.calls!.push(`guild_${m.guild_id}`, trace);
        } else {
            console.error(`[Gateway/${this.user_id}] Member ${m.id} has invalid guild_id ${m.guild_id}`);
            mergeMemberGuildsTrace.calls!.push(`guild_~~${m.guild_id}~~`, trace);
        }
    });

    for (const call of mergeMemberGuildsTrace.calls!) {
        if (typeof call !== "string") mergeMemberGuildsTrace.micros += (call as { micros: number }).micros;
    }

    const guildRelationQueryTime = taskSw.getElapsedAndReset();

    // We forgot to migrate user settings from the JSON column of `users`
    // to the `user_settings` table theyre in now,
    // so for instances that migrated, users may not have a `user_settings` row.
    let createUserSettingsTime: ElapsedTime | undefined;
    if (!user.settings) {
        user.settings = await UserSettings.getOrDefault(user.id);
        createUserSettingsTime = taskSw.getElapsedAndReset();
    }

    // Generate merged_members
    const merged_members = members.map((x) => [
        {
            ...x,
            // filter out @everyone role
            roles: x.roles.filter((r) => r.id !== x.guild.id).map((x) => x.id),

            // add back user, which we don't fetch from db
            // TODO: For guild profiles, this may need to be changed.
            // TODO: The only field required in the user prop is `id`,
            // but our types are annoying so I didn't bother.
            user: user.toPublicUser(),

            guild: {
                id: x.guild.id,
            },
            settings: undefined,
        },
    ]);
    const mergedMembersTime = taskSw.getElapsedAndReset();

    // Populated with guilds 'unavailable' currently
    // Just for bots
    //TODO get this a better type
    const pending_guilds: { id: string }[] = [];

    // Generate guilds list ( make them unavailable if user is bot )
    const guilds: GuildOrUnavailable[] = members.map((member) => {
        member.guild.channels = (guildCache.get(member.guild_id)?.channels ?? [])
            /*
   			//TODO maybe implement this correctly, by causing create and delete events for users who can newly view and not view the channels, along with doing these checks correctly, as they don't currently take into account that the owner of the guild is always able to view channels, with potentially other issues
   			.filter((channel) => {
				const perms = Permissions.finalPermission({
					user: {
						id: member.id,
						roles: member.roles.map((x) => x.id),
					},
					guild: member.guild,
					channel,
				});

				return perms.has("VIEW_CHANNEL");
			})
   			*/
            .map((channel) => {
                channel.position = member.guild.channel_ordering.indexOf(channel.id);
                return channel;
            })
            .sort((a, b) => a.position! - b.position!) as unknown as Channel[];

        const threads: Channel[] = threadsByGuild.get(member.guild_id) ?? [];

        const guildjson = {
            ...member.guild.toJSON(),
            joined_at: member.joined_at,

            threads: threads.map((thread) => {
                const member = threadMemberMap.get(thread.id)?.toJSON();
                return {
                    ...thread.toJSON(),
                    member,
                };
            }),
            guild_scheduled_events: (scheduledEventsByGuild.get(member.guild_id) ?? []).map((e) => e.toJSON(scheduledEventCounts.get(e.id) ?? 0)),
            stage_instances: (stageInstancesByGuild.get(member.guild_id) ?? []).map((i) => i.toJSON()),
            presences: prioritizedReady
                ? []
                : (guildPresenceMembersByGuild.get(member.guild_id) ?? [])
                      .filter((m) => guildPresenceMap.has(m.id))
                      .map((m) => ({ user: { id: m.id }, ...guildPresenceMap.get(m.id)! })),
        };

        if (user.bot) {
            pending_guilds.push(guildjson);
            return { id: member.guild.id, unavailable: true };
        }

        return guildjson;
    });
    const generateGuildsListTime = taskSw.getElapsedAndReset();

    // Generate user_guild_settings
    const user_guild_settings_entries: ReadyUserGuildSettingsEntries[] = members
        .filter((x) => (x.settings?.version ?? 0) > 0)
        .map((x) => userGuildSettingsEntry(x.settings, x.guild_id, x.guild?.default_message_notifications));
    const generateUserGuildSettingsTime = taskSw.getElapsedAndReset();

    // Populated with users from private channels, relationships.
    // Uses a set to dedupe for us.
    const users = new Map<string, PublicUser>();
    const addUser = (value: PublicUser) => users.has(value.id) || users.set(value.id, value);

    // Generate dm channels from recipients list. Append recipients to `users` list
    const channels = recipients
        .filter(({ channel }) => channel.isDm())
        .map((r) => {
            // TODO: fix the types of Recipient
            // Their channels are only ever private (I think) and thus are always DM channels
            const channel = r.channel as DMChannel;

            // Remove ourself from the list of other users in dm channel
            channel.recipients = channel.recipients.filter((recipient) => recipient.user.id !== this.user_id);

            let channelUsers = channel.recipients?.map((recipient) => recipient.user.toPublicUser());

            if (channelUsers && channelUsers.length > 0) channelUsers.forEach(addUser);
            // HACK: insert self into recipients for DMs with users that no longer exist
            else if (channel.type === ChannelType.DM) {
                const selfUser = user.toPublicUser();
                addUser(selfUser);
                channelUsers ??= [];
                channelUsers.push(selfUser);
            }

            return {
                id: channel.id,
                flags: channel.flags,
                last_message_id: channel.last_message_id,
                type: channel.type,
                recipients: channelUsers || [],
                icon: channel.icon,
                name: channel.name,
                is_spam: false, // TODO
                is_message_request: !!r.message_request_timestamp,
                is_message_request_timestamp: r.message_request_timestamp?.toISOString() ?? null,
                owner_id: channel.owner_id || undefined,
            };
        });
    const generateDmChannelsTime = taskSw.getElapsedAndReset();

    // From user relationships ( friends ), also append to `users` list
    user.relationships.forEach((x) => addUser(x.to.toPublicUser()));
    guildPresenceUsers.filter((x) => guildPresenceMap.has(x.id)).forEach((x) => addUser(x.toPublicUser()));
    const appendRelationshipsTime = taskSw.getElapsedAndReset();

    const allSessions = sessions.concat(this.session!).map((x) => x.toPrivateGatewayDeviceInfo());
    const ownSessions = allSessions.map((x) => (x.session_id === session.session_id ? { ...x, session_id: this.session_id } : x));
    const findAndGenerateSessionReplaceTime = taskSw.getElapsedAndReset();

    const { elapsed: emitSessionsReplaceTime } = await timePromise(() =>
        emitEvent({
            event: "SESSIONS_REPLACE",
            user_id: this.user_id,
            data: allSessions,
        } as SessionsReplace),
    );

    taskSw.reset();
    // Build READY

    // const remapReadStateIdsTime = taskSw.getElapsedAndReset();
    const buildReadyTrace: TraceNode = {
        micros: 0,
        calls: [],
    };
    const { elapsed: remapReadStateIdsTime } = timeFunction(() =>
        read_states.forEach((x) => {
            x.id = x.channel_id;
        }),
    );
    buildReadyTrace.calls!.push("remapReadStateIds", {
        micros: remapReadStateIdsTime.totalMicroseconds,
    });

    const { result: user_settings_proto, elapsed: serialiseUserSettingsProtoTime } = timeFunction(() =>
        settingsProtos?.userSettings ? PreloadedUserSettings.toBase64(settingsProtos.userSettings) : undefined,
    );
    buildReadyTrace.calls!.push("serializeUserSettingsProto", {
        micros: serialiseUserSettingsProtoTime.totalMicroseconds,
    });

    const { result: user_settings_proto_json, elapsed: serialiseUserSettingsProtoJsonTime } = timeFunction(() =>
        settingsProtos?.userSettings ? PreloadedUserSettings.toJson(settingsProtos.userSettings) : undefined,
    );
    buildReadyTrace.calls!.push("serializeUserSettingsProtoJson", {
        micros: serialiseUserSettingsProtoJsonTime.totalMicroseconds,
    });

    const clientGuildVersions = new Map(
        Object.entries((identify.client_state?.guild_versions ?? {}) as Record<string, unknown>)
            .map(([id, version]) => [id, Number(version)] as const)
            .filter(([id, version]) => memberGuildIds.includes(id) && Number.isFinite(version) && version >= Date.now() - GUILD_VERSION_HORIZON),
    );
    const guildEntityDeletes =
        clientGuildVersions.size && this.capabilities!.has(Capabilities.FLAGS.CLIENT_STATE_V2)
            ? arrayGroupBy(
                  (await getDatabase()!.query(
                      `SELECT d.guild_id, d.entity_type, d.entity_id, d.version FROM guild_entity_deletes d
                       JOIN unnest($1::bigint[], $2::bigint[]) AS v(guild_id, version) ON d.guild_id = v.guild_id AND d.version > v.version`,
                      [[...clientGuildVersions.keys()], [...clientGuildVersions.values()]],
                  )) as (GuildEntityDelete & { guild_id: string })[],
                  (entry) => `${entry.guild_id}`,
              )
            : new Map<string, GuildEntityDelete[]>();
    const { result: remappedGuilds, elapsed: remapGuildsTime } = timeFunction(() =>
        this.capabilities!.has(Capabilities.FLAGS.CLIENT_STATE_V2)
            ? guilds.map((x) =>
                  new ReadyGuildDTO(
                      x,
                      clientGuildVersions.has(x.id)
                          ? {
                                version: clientGuildVersions.get(x.id)!,
                                deletes: guildEntityDeletes.get(x.id) ?? [],
                            }
                          : undefined,
                  ).toJSON(),
              )
            : guilds,
    );
    for (const guild of remappedGuilds as { id: string; experiments?: unknown }[]) {
        const experiments = getGuildExperiments(guild.id);
        if (experiments) guild.experiments = experiments;
    }
    buildReadyTrace.calls!.push(this.capabilities!.has(Capabilities.FLAGS.CLIENT_STATE_V2) ? "remapGuilds" : "[NoOP] remapGuilds", { micros: remapGuildsTime.totalMicroseconds });

    const { result: remappedRelationships, elapsed: remapRelationshipsTime } = timeFunction(() => user.relationships.map((x) => x.toPublicRelationship()));
    buildReadyTrace.calls!.push("remapRelationships", {
        micros: remapRelationshipsTime.totalMicroseconds,
    });

    buildReadyTrace.micros = buildReadyTrace.calls!.reduce((a, b) => {
        if (typeof b === "string") return a;
        return a + (b as { micros: number }).micros;
    }, 0);

    const [authenticator_types, preferences, guild_join_requests] = await Promise.all([
        SecurityKey.authenticatorTypes(this.user_id),
        User.findOne({
            where: { id: this.user_id },
            select: { id: true, account_preferences: true, private_channel_settings: true },
        }),
        GuildJoinRequest.activeForUser(this.user_id),
    ]);

    // const d: ReadyEventData = {
    const { result: d, elapsed: buildReadyEventDataTime } = timeFunction<ReadyEventData>(
        () =>
            ({
                v: 9,
                application: application ? { id: application.id, flags: application.flags } : undefined,
                user: user.toPrivateUser(["rights"]),
                user_settings: user.settings?.toLegacy(settingsProtos?.userSettings),
                user_settings_proto,
                user_settings_proto_json,
                guilds: remappedGuilds,
                relationships: remappedRelationships,
                read_state: {
                    entries: read_states,
                    partial: false,
                    version: 0, // TODO
                },
                user_guild_settings: {
                    entries: preferences?.private_channel_settings
                        ? [...user_guild_settings_entries, userGuildSettingsEntry(preferences.private_channel_settings, null)]
                        : user_guild_settings_entries,
                    partial: false,
                    version: 0, // TODO
                },
                private_channels: channels,
                presences: prioritizedReady ? [] : friendPresences,
                session_id: this.session_id,
                country_code: this.session?.last_seen_location_info?.country_code ?? (user.settings?.locale?.split("-")[1] || "US").toUpperCase(),
                users: Array.from(users.values()),
                merged_members: merged_members,
                sessions: ownSessions,

                resume_gateway_url: Config.get().gateway.endpointPublic!,

                // lol hack whatever
                required_action: requiredAction(user) ?? undefined,

                consents: {
                    personalization: {
                        consented: !!preferences?.account_preferences?.consents?.personalization,
                    },
                },
                experiments: [],
                guild_join_requests: guild_join_requests.map((request) => request.toJSON("self")),
                connected_accounts: [],
                guild_experiments: [],
                apex_experiments: getApexExperiments(this.user_id),
                geo_ordered_rtc_regions: [],
                api_code_version: 1,
                friend_suggestion_count: 0,
                analytics_token: "",
                tutorial: null,
                session_type: "normal", // TODO
                auth_session_id_hash: this.session!.getDiscordDeviceInfo().id_hash,
                auth: { authenticator_types },
                notification_settings: {
                    // ????
                    flags: 0,
                },
                game_relationships: [],
            }) satisfies ReadyEventData,
    );

    if (this.capabilities.has(Capabilities.FLAGS.AUTH_TOKEN_REFRESH) && tokenData.tokenVersion != CurrentTokenFormatVersion) {
        d.auth_token = this.accessToken = (await generateToken(this.user_id, false, undefined, session))!;
    }
    // const buildReadyEventDataTime = taskSw.getElapsedAndReset();

    const _trace = [
        gatewayShardName,
        {
            micros: totalSw.elapsed().totalMicroseconds,
            calls: [],
        },
    ] as TraceRoot;
    const times = {
        parseAndValidateTime,
        checkTokenTime,
        userQueryTime,
        validateIntentsAndShardingTime,
        createSessionTime,
        userMetaQueryTime,
        queryGuildsTime,
        guildRelationQueryTime,
        createUserSettingsTime,
        friendPresenceSessionsQueryTime,
        mergedMembersTime,
        generateGuildsListTime,
        generateUserGuildSettingsTime,
        generateDmChannelsTime,
        generateFriendPresencesTime,
        appendRelationshipsTime,
        findAndGenerateSessionReplaceTime,
        emitSessionsReplaceTime,
        remapReadStateIdsTime,
        buildReadyEventDataTime,
        threadMemberTime,
    };
    for (const [key, value] of Object.entries(times)) {
        if (value) {
            const val = { micros: value.totalMicroseconds } as { micros: number; calls: TraceNode[] };
            _trace![1].calls.push(key, val);
            if (key === "userMetaQueryTime") {
                val.calls = [];
                for (const [subkey, subvalue] of Object.entries({
                    sessionSaveTime,
                    sessionQueryTime,
                    relationshipQueryTime,
                    friendPresenceSessionsQueryTime,
                    settingsQueryTime,
                    settingsProtosQueryTime,
                    applicationQueryTime,
                    read_statesQueryTime,
                    membersQueryTime,
                    recipientsQueryTime,
                })) {
                    if (subvalue) {
                        val.calls.push(subkey, {
                            micros: subvalue.totalMicroseconds,
                        } as TraceNode);
                    }
                }
            } else if (key === "guildRelationQueryTime") {
                val.calls = [];
                for (const [subkey, subvalue] of Object.entries({
                    guildCacheTime,
                    queryGuildVoiceStatesTime: queryGuildVoiceStatesTimeTotal,
                    threadMemberTime,
                    queryThreadsTime: queryThreadsTimeTotal,
                })) {
                    if (subvalue) {
                        val.calls.push(subkey, {
                            micros: subvalue.totalMicroseconds,
                        } as TraceNode);
                    }
                }

                val.calls.push("mergeMemberGuildsTrace", mergeMemberGuildsTrace);
            } else if (key === "buildReadyEventDataTime") {
                val.calls = ["readyDataSerializationTime", buildReadyTrace];
                val.micros += buildReadyTrace.micros;
            }
        }
    }
    _trace![1].calls.push("buildTraceTime", {
        micros: taskSw.elapsed().totalMicroseconds,
    });
    d._trace = [JSON.stringify(_trace)];

    await listenerPromise;

    if (this.readyState !== this.OPEN) {
        if (!openConnections.some((x) => x !== this && x.session?.session_id === session.session_id && x.user_id === this.user_id)) {
            await Session.update({ user_id: this.user_id, session_id: session.session_id }, { status: "offline", activities: [], client_status: {} });
            await emitSessionsReplace(this.user_id);
            await broadcastPresence(this.user_id);
        }
        return;
    }

    clearTimeout(this.readyTimeout);
    // Send READY
    await Send(this, {
        op: OPCODES.Dispatch,
        t: EVENTEnum.Ready,
        s: this.sequence++,
        d,
    });

    // If we're a bot user, send GUILD_CREATE for each unavailable guild
    // TODO: check if bot has permission to view some of these based on intents (i.e. GUILD_MEMBERS, GUILD_PRESENCES, GUILD_VOICE_STATES)
    await Promise.all(
        pending_guilds.map((x) => {
            //Even with the GUILD_MEMBERS intent, the bot always receives just itself as the guild members
            const botMemberObject = members.find((member) => member.guild_id === x.id);

            return Send(this, {
                op: OPCODES.Dispatch,
                t: EVENTEnum.GuildCreate,
                s: this.sequence++,
                d: {
                    ...x,
                    members: botMemberObject
                        ? [
                              {
                                  ...botMemberObject.toPublicMember(),
                                  user: user.toPublicUser(),
                              },
                          ]
                        : [],
                },
            })?.catch((e) => console.error(`[Gateway/${this.user_id}] error when sending bot guilds`, e));
        }),
    );

    const activityInstances = await ActivityInstances.forGuilds(guilds.filter((guild) => "voice_states" in guild).map((guild) => guild.id));
    const readySupplementalGuilds = guilds.map((guild) => {
        if (!("voice_states" in guild)) return { id: guild.id };

        const availableGuild = guild as Guild;
        return {
            id: availableGuild.id,
            voice_states: availableGuild.voice_states.map((state) => VoiceState.prototype.toPublicVoiceState.apply(state)),
            // embedded_activities is the older name for the same field, kept for clients that still read it
            embedded_activities: [],
            activity_instances: activityInstances.get(availableGuild.id) ?? [],
        };
    });

    const supplementalGuildMembers = guilds.map((guild) =>
        (guildPresenceMembersByGuild.get(guild.id) ?? []).filter((m) => guildPresenceMap.has(m.id)).map(({ id, ...member }) => ({ ...member, user_id: id })),
    );

    await Send(this, {
        op: OPCodes.DISPATCH,
        t: EVENTEnum.ReadySupplemental,
        s: this.sequence++,
        d: {
            guilds: readySupplementalGuilds,
            merged_members: supplementalGuildMembers,
            merged_presences: {
                friends: friendPresences.map(({ user, ...presence }) => ({
                    ...presence,
                    user_id: user.id,
                })),
                guilds: supplementalGuildMembers.map((members) => members.map((m) => ({ ...guildPresenceMap.get(m.user_id)!, user_id: m.user_id }))),
            },
            lazy_private_channels: [],
            disclose: [],
            game_invites: [],
        },
    });

    const pendingDispatches = this.pendingDispatches;
    this.pendingDispatches = undefined;
    for (const payload of pendingDispatches) await Send(this, { ...payload, s: this.sequence++ });
    for (const call of await PrivateCalls.activeFor(this.user_id).catch(() => [])) await Send(this, { op: OPCodes.DISPATCH, t: "CALL_CREATE", s: this.sequence++, d: call });
    console.log(
        `[Gateway/${this.user_id}] IDENTIFY ${this.user_id} in ${totalSw.elapsed().totalMilliseconds}ms`,
        process.env.LOG_GATEWAY_TRACES ? JSON.stringify(d._trace, null, 2) : "",
    );

    await broadcastPresence(this.user_id);
}
