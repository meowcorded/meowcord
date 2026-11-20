import { Invite, Relationship, User } from "@spacebar/database";
import { RelationshipType } from "@spacebar/schemas";
import { Config, DiscordApiErrors, PresenceUpdateEvent, RelationshipAddEvent, Snowflake, emitEvent, getUserPresence } from "@spacebar/util";
import { In, IsNull, LessThan, MoreThan } from "typeorm";
import crypto from "node:crypto";

export const FRIEND_INVITE_MAX_AGE = 7 * 24 * 60 * 60;
export const FRIEND_INVITE_MAX_USES = 5;
export const FRIEND_INVITE_ACTIVE_LIMIT = 5;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const friendInviteWhere = (user_id: string) => ({ inviter_id: user_id, guild_id: IsNull(), channel_id: IsNull() });

export async function listFriendInvites(user_id: string) {
    await Invite.delete({ ...friendInviteWhere(user_id), expires_at: LessThan(new Date()) });
    return (await Invite.find({ where: { ...friendInviteWhere(user_id), expires_at: MoreThan(new Date()) }, relations: { inviter: true }, order: { created_at: "DESC" } })).filter(
        (invite) => !invite.isExpired(),
    );
}

export async function createFriendInvite(user_id: string) {
    const active = await listFriendInvites(user_id);
    const stale = active.slice(FRIEND_INVITE_ACTIVE_LIMIT - 1);
    if (stale.length) await Invite.delete({ code: In(stale.map((invite) => invite.code)) });
    const created_at = new Date();
    const code = Array.from(crypto.randomBytes(10), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
    await Invite.insert({
        code,
        temporary: false,
        uses: 0,
        max_uses: FRIEND_INVITE_MAX_USES,
        max_age: FRIEND_INVITE_MAX_AGE,
        created_at,
        expires_at: new Date(created_at.getTime() + FRIEND_INVITE_MAX_AGE * 1000),
        inviter_id: user_id,
        flags: 0,
    });
    return Invite.findOneOrFail({ where: { code }, relations: { inviter: true } });
}

export async function revokeFriendInvites(user_id: string) {
    const invites = await listFriendInvites(user_id);
    if (invites.length) await Invite.delete({ code: In(invites.map((invite) => invite.code)) });
    return invites;
}

export async function acceptFriendInvite(invite: Invite, user_id: string) {
    if (invite.isExpired()) {
        await Invite.delete({ code: invite.code });
        throw DiscordApiErrors.UNKNOWN_INVITE;
    }
    const inviter_id = invite.inviter_id as string;
    if (inviter_id === user_id) throw DiscordApiErrors.CANNOT_FRIEND_SELF;

    const [mine, theirs] = await Promise.all([
        Relationship.findOne({ where: { from_id: user_id, to_id: inviter_id } }),
        Relationship.findOne({ where: { from_id: inviter_id, to_id: user_id } }),
    ]);
    if (theirs?.type === RelationshipType.BLOCKED) throw DiscordApiErrors.FRIEND_REQUEST_BLOCKED;
    if (mine?.type === RelationshipType.BLOCKED) throw DiscordApiErrors.FRIEND_REQUEST_BLOCKED;
    if (mine?.type === RelationshipType.FRIEND && theirs?.type === RelationshipType.FRIEND) return { new_friend: false };

    const { maxFriends } = Config.get().limits.user;
    const [ownCount, theirCount] = await Promise.all([Relationship.count({ where: { from_id: user_id } }), Relationship.count({ where: { from_id: inviter_id } })]);
    if ((!mine && ownCount >= maxFriends) || (!theirs && theirCount >= maxFriends)) throw DiscordApiErrors.MAXIMUM_FRIENDS.withParams(maxFriends);

    const claimed = await Invite.createQueryBuilder()
        .update()
        .set({ uses: () => "uses + 1" })
        .where("code = :code AND (max_uses = 0 OR uses < max_uses)", { code: invite.code })
        .execute();
    if (!claimed.affected) throw DiscordApiErrors.UNKNOWN_INVITE;

    const since = new Date();
    const befriend = (row: Relationship | null, from_id: string, to_id: string) =>
        Object.assign(row ?? Relationship.create({ id: Snowflake.generate(), from_id, to_id }), { type: RelationshipType.FRIEND, since, note: null, nickname: row?.nickname });
    const outgoing = befriend(mine, user_id, inviter_id);
    const incoming = befriend(theirs, inviter_id, user_id);
    await Promise.all([outgoing.save(), incoming.save()]);

    invite.uses++;
    if (invite.max_uses !== 0 && invite.uses >= invite.max_uses) await Invite.delete({ code: invite.code });

    const [me, inviter, ownPresence, inviterPresence] = await Promise.all([
        User.findOneOrFail({ where: { id: user_id } }),
        User.findOneOrFail({ where: { id: inviter_id } }),
        getUserPresence(user_id),
        getUserPresence(inviter_id),
    ]);
    outgoing.to = inviter;
    incoming.to = me;
    await Promise.all([
        emitEvent({ event: "RELATIONSHIP_ADD", data: outgoing.toPublicRelationship(), user_id } satisfies RelationshipAddEvent),
        emitEvent({ event: "RELATIONSHIP_ADD", data: { ...incoming.toPublicRelationship(), should_notify: true }, user_id: inviter_id } satisfies RelationshipAddEvent),
        emitEvent({ event: "PRESENCE_UPDATE", data: { user: inviter.toPublicUser(), ...inviterPresence }, user_id } satisfies PresenceUpdateEvent),
        emitEvent({ event: "PRESENCE_UPDATE", data: { user: me.toPublicUser(), ...ownPresence }, user_id: inviter_id } satisfies PresenceUpdateEvent),
    ]);
    return { new_friend: true };
}
