import { sqlLike } from "@spacebar/database/Sql";
import { In } from "typeorm";
import { getDatabase, Member } from "@spacebar/database";
import { WebSocket, Payload, OPCODES, Send, handleOffloadedGatewayRequest } from "@spacebar/gateway";
import { PublicUser, RequestGuildMembersSchema } from "@spacebar/schemas";
import { Config, getPermission, getUserPresences, GuildMembersChunkEvent, Presence } from "@spacebar/util";
import { check } from "./instanceOf";

const FullMemberRequestWindow = 30_000;

export async function onRequestGuildMembers(this: WebSocket, { d }: Payload) {
    const startTime = Date.now();
    // Schema validation can only accept either string or array, so transforming it here to support both
    if (!d.guild_id) throw new Error('"guild_id" is required');
    d.guild_id = Array.isArray(d.guild_id) ? d.guild_id[0] : d.guild_id;

    if (d.user_ids && !Array.isArray(d.user_ids)) d.user_ids = [d.user_ids];

    if (Config.get().offload.gateway.guildMembersUrl !== null) {
        const guildIds: string[] = Array.isArray(d.guild_id) ? d.guild_id : [d.guild_id];
        if (await handleOffloadedGatewayRequest(this, Config.get().offload.gateway.guildMembersUrl!, guildIds)) return;
    }

    check.call(this, RequestGuildMembersSchema, d);

    const { presences, nonce, query: requestQuery } = d as RequestGuildMembersSchema;
    let { limit, user_ids, guild_id } = d as RequestGuildMembersSchema;

    // some discord libraries send empty string as query when they meant to send undefined, which was leading to errors being thrown in this handler
    const query = requestQuery != "" ? requestQuery : undefined;

    guild_id = guild_id as string;
    user_ids = user_ids as string[] | undefined;

    if (d.query && (!limit || Number.isNaN(limit))) {
        console.log("Query:", d);
        throw new Error('"query" requires "limit" to be set');
    }

    if (d.query && user_ids) {
        console.log("Query:", d);
        throw new Error('"query" and "user_ids" are mutually exclusive');
    }

    // TODO: Configurable limit?
    if ((query || (user_ids && user_ids.length > 0)) && (!limit || limit > 100)) limit = 100;

    const permissions = await getPermission(this.user_id, guild_id);
    permissions.hasThrow("VIEW_CHANNEL");

    if (!query && !user_ids?.length && !limit && !this.isBot) {
        if (!permissions.has("MANAGE_ROLES") && !permissions.has("KICK_MEMBERS") && !permissions.has("BAN_MEMBERS")) return;
        const now = Date.now();
        this.fullMemberRequests ??= {};
        const last = this.fullMemberRequests[guild_id] ?? 0;
        if (now - last < FullMemberRequestWindow)
            return Send(this, {
                op: OPCODES.Dispatch,
                s: this.sequence++,
                t: "RATE_LIMITED",
                d: {
                    opcode: OPCODES.Request_Guild_Members,
                    retry_after: (FullMemberRequestWindow - (now - last)) / 1000,
                    meta: { guild_id, nonce },
                },
            });
        this.fullMemberRequests[guild_id] = now;
    }

    const db = getDatabase();
    if (!db) throw new Error("Database not initialized");

    const selection = db.getRepository(Member).createQueryBuilder("member").where("member.guild_id = :guild_id", { guild_id });
    if (query) {
        selection
            .leftJoin("member.user", "user")
            .andWhere(`(${sqlLike("user.username", ":query")} OR ${sqlLike("user.global_name", ":query")} OR ${sqlLike("member.nick", ":query")})`, {
                query: `${query}%`,
            });
    } else if (user_ids?.length) {
        selection.andWhere("member.id IN (:...user_ids)", { user_ids });
    }

    const memberCount = await selection.getCount();
    const memberResultCount = limit ? Math.min(memberCount, Math.abs(Number(limit))) : memberCount;

    const baseData = {
        guild_id,
        nonce,
    };

    const chunkSize = 1000;
    const chunkCount = Math.ceil(memberResultCount / chunkSize);
    let sentChunkCount = 0;

    let notFound: string[] = [];
    let cursor: string | undefined;
    let remaining = memberResultCount;
    while (remaining > 0) {
        const page = selection.clone().select("member.id", "id").orderBy("member.id", "ASC").limit(Math.min(chunkSize, remaining));
        if (cursor) page.andWhere("member.id > :cursor", { cursor });
        const ids = (await page.getRawMany<{ id: string }>()).map((row) => row.id);
        if (!ids.length) break;
        cursor = ids[ids.length - 1];
        remaining -= ids.length;
        const hydrated = await Member.find({
            where: { guild_id, id: In(ids) },
            relations: { user: true, roles: true },
        });
        const byId = new Map(hydrated.map((member) => [member.id, member]));
        const chunk = ids.map((id) => byId.get(id)).filter((member): member is Member => !!member);
        if (user_ids?.length) notFound = user_ids.filter((id) => !byId.has(id));

        let presenceList: Presence[] = [];
        if (presences) {
            const presenceMap = await getUserPresences(chunk.map((m) => m.id));
            presenceList = chunk.filter((m) => presenceMap.has(m.id)).map((m) => ({ user: { id: m.id } as PublicUser, ...presenceMap.get(m.id)! }));
        }

        await Send(this, {
            op: OPCODES.Dispatch,
            s: this.sequence++,
            t: "GUILD_MEMBERS_CHUNK",
            d: {
                ...baseData,
                members: chunk.map((member) => ({
                    ...member.toPublicMember(),
                    roles: member.roles.filter((r) => r.id !== guild_id).map((r) => r.id),
                })),
                presences: presences ? presenceList : undefined,
                chunk_index: sentChunkCount,
                chunk_count: chunkCount,

                ...(sentChunkCount == 0 ? { not_found: notFound } : {}),
            } satisfies GuildMembersChunkEvent["data"],
        });
        sentChunkCount++;

        console.log(
            `[Gateway/${this.user_id}] REQUEST_GUILD_MEMBERS @ ${Date.now() - startTime}ms for guild ${guild_id}: pushed ${sentChunkCount}/${chunkCount} chunks (${memberResultCount} total members considered)`,
        );
    }

    if (sentChunkCount == 0)
        await Send(this, {
            op: OPCODES.Dispatch,
            s: this.sequence++,
            t: "GUILD_MEMBERS_CHUNK",
            d: {
                ...baseData,
                members: [],
                presences: presences ? [] : undefined,
                chunk_index: 0,
                chunk_count: 1,
                not_found: user_ids?.length ? user_ids : notFound,
            } satisfies GuildMembersChunkEvent["data"],
        });

    console.log(`[Gateway/${this.user_id}] REQUEST_GUILD_MEMBERS took ${Date.now() - startTime}ms for guild ${guild_id} with ${memberResultCount} (${memberCount}) members`);
}
