import { In, Not } from "typeorm";
import { emitEvent } from "@spacebar/util/util";
import { Snowflake } from "@spacebar/util/util/Snowflake";
import { EmbeddedActivityInstance, EmbeddedActivityLocation, EmbeddedActivityUpdateV2Event } from "../../util/interfaces/Event";
import { ActivityInstance, ActivityInstanceParticipant } from "../entities/EmbeddedActivity";
import { Member } from "../entities/Member";
import { getDatabase } from "../Database";

type Listener = (instance: ActivityInstance, participants: ActivityInstanceParticipant[]) => void;

export class ActivityInstances {
    private static listeners = new Set<Listener>();

    static onChange(listener: Listener) {
        ActivityInstances.listeners.add(listener);
        return () => ActivityInstances.listeners.delete(listener);
    }

    static location(channelId: string, guildId?: string | null): EmbeddedActivityLocation {
        return guildId ? { id: `gc-${guildId}-${channelId}`, kind: "gc", channel_id: channelId, guild_id: guildId } : { id: `pc-${channelId}`, kind: "pc", channel_id: channelId };
    }

    static compositeId(instance: Pick<ActivityInstance, "id" | "channel_id" | "guild_id">) {
        return `i-${instance.id}-${ActivityInstances.location(instance.channel_id, instance.guild_id).id}`;
    }

    static participants(instanceId: string) {
        return ActivityInstanceParticipant.find({
            where: { instance_id: instanceId },
            order: { joined_at: "ASC" },
        });
    }

    static find(applicationId: string, instanceId: string) {
        const launchId = /^i-(\d+)-/.exec(instanceId)?.[1] ?? instanceId;
        if (!/^\d+$/.test(launchId)) return Promise.resolve(null);
        return ActivityInstance.findOne({ where: { id: launchId, application_id: applicationId } });
    }

    static async serialize(instance: ActivityInstance, participants?: ActivityInstanceParticipant[]): Promise<EmbeddedActivityInstance> {
        const rows = participants ?? (await ActivityInstances.participants(instance.id));
        const members =
            instance.guild_id && rows.length
                ? await Member.find({
                      where: { guild_id: instance.guild_id, id: In(rows.map((r) => r.user_id)) },
                      relations: { user: true, roles: true },
                  })
                : [];
        return {
            application_id: instance.application_id,
            launch_id: instance.id,
            composite_instance_id: ActivityInstances.compositeId(instance),
            location: ActivityInstances.location(instance.channel_id, instance.guild_id),
            participants: rows.map((row) => {
                const member = members.find((m) => m.id === row.user_id);
                return {
                    user_id: row.user_id,
                    session_id: row.session_id,
                    ...(row.nonce && { nonce: row.nonce }),
                    ...(member && { member: member.toPublicMember() }),
                };
            }),
        };
    }

    static async publish(instance: ActivityInstance, participants?: ActivityInstanceParticipant[]) {
        const rows = participants ?? (await ActivityInstances.participants(instance.id));
        const data = await ActivityInstances.serialize(instance, rows);
        await emitEvent({
            event: "EMBEDDED_ACTIVITY_UPDATE_V2",
            ...(instance.guild_id ? { guild_id: instance.guild_id } : { channel_id: instance.channel_id }),
            data: { ...data, ...(instance.guild_id && { guild_id: instance.guild_id }) },
        } satisfies EmbeddedActivityUpdateV2Event);
        for (const listener of ActivityInstances.listeners) listener(instance, rows);
        return data;
    }

    static async join(opts: { applicationId: string; channelId: string; guildId?: string | null; userId: string; sessionId: string; nonce?: string | null }) {
        await ActivityInstance.createQueryBuilder()
            .insert()
            .values({
                id: Snowflake.generate(),
                application_id: opts.applicationId,
                channel_id: opts.channelId,
                guild_id: opts.guildId ?? null,
            })
            .orIgnore()
            .execute();
        const instance = await ActivityInstance.findOneOrFail({
            where: { application_id: opts.applicationId, channel_id: opts.channelId },
        });

        const elsewhere = await ActivityInstanceParticipant.find({
            where: { user_id: opts.userId, instance_id: Not(instance.id) },
            relations: { instance: true },
        });
        for (const row of elsewhere) await ActivityInstances.leave(row.instance, opts.userId);

        await ActivityInstanceParticipant.upsert(
            {
                instance_id: instance.id,
                user_id: opts.userId,
                session_id: opts.sessionId,
                nonce: opts.nonce ?? null,
                joined_at: new Date(),
            },
            ["instance_id", "user_id"],
        );
        return { instance, data: await ActivityInstances.publish(instance) };
    }

    static async leave(instance: ActivityInstance, userId: string, sessionId?: string) {
        const removed = await ActivityInstanceParticipant.delete({
            instance_id: instance.id,
            user_id: userId,
            ...(sessionId && { session_id: sessionId }),
        });
        if (!removed.affected) return false;
        const rest = await ActivityInstances.participants(instance.id);
        if (!rest.length) await ActivityInstance.delete({ id: instance.id });
        await ActivityInstances.publish(instance, rest);
        return true;
    }

    static async userLeftChannel(channelId: string, userId: string) {
        const rows = await ActivityInstanceParticipant.find({
            where: { user_id: userId, instance: { channel_id: channelId } },
            relations: { instance: true },
        });
        for (const row of rows) await ActivityInstances.leave(row.instance, userId);
    }

    static async forGuilds(guildIds: string[]) {
        const byGuild = new Map<string, EmbeddedActivityInstance[]>();
        if (!guildIds.length) return byGuild;
        const instances = await ActivityInstance.find({
            where: { guild_id: In(guildIds) },
            relations: { participants: true },
        });
        for (const instance of instances) {
            if (!instance.participants.length) continue;
            const list = byGuild.get(instance.guild_id!) ?? [];
            list.push(await ActivityInstances.serialize(instance, instance.participants));
            byGuild.set(instance.guild_id!, list);
        }
        return byGuild;
    }

    static async sweep() {
        await getDatabase()?.query(
            `DELETE FROM "activity_instance_participants" AS p WHERE EXISTS (SELECT 1 FROM "activity_instances" i WHERE p."instance_id" = i."id" AND NOT EXISTS (SELECT 1 FROM "voice_states" v WHERE v."user_id" = p."user_id" AND v."channel_id" = i."channel_id" AND v."session_id" = p."session_id"))`,
        );
        await getDatabase()?.query(`DELETE FROM "activity_instances" AS i WHERE NOT EXISTS (SELECT 1 FROM "activity_instance_participants" p WHERE p."instance_id" = i."id")`);
    }
}
