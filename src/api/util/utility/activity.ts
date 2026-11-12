import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MoreThan, Not } from "typeorm";
import { GoLiveStreams, Session, Stream, StreamSession, User } from "@spacebar/database";
import { sqlReturning } from "@spacebar/database/Sql";
import { emitEvent, UserUpdateEvent } from "@spacebar/util";
import { ProcessLifecycle } from "@spacebar/util/util/ProcessLifecycle";
import { DetectableGames } from "./games";
import { milestones, type ActivityProgress } from "./milestones";

export const MAX_ACTIVITY_GAP = 120000;
export const MAX_ACTIVITY_TIME = 5000 * 3600000;
export interface ActivityWindow {
    at: number;
    playing: boolean;
    streaming: boolean;
}
const windows = new Map<string, ActivityWindow>();
const pending = new Map<string, Promise<void>>();
let secret: Promise<Buffer> | undefined;

async function activitySecret() {
    const file = path.join(process.env.CONFIG_PATH ? path.dirname(process.env.CONFIG_PATH) : process.cwd(), "activity.key");
    const current = await fs.readFile(file).catch(() => null);
    if (current?.length === 32) return current;
    const temporary = `${file}.${randomBytes(8).toString("hex")}`;
    await fs.writeFile(temporary, randomBytes(32), { mode: 0o600, flag: "wx" });
    try {
        await fs.link(temporary, file).catch((error) => {
            if (error.code !== "EEXIST") throw error;
        });
    } finally {
        await fs.unlink(temporary);
    }
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error("invalid activity key");
    return key;
}

export function advanceActivity(progress: ActivityProgress | undefined, previous: ActivityWindow | undefined, current: ActivityWindow, games: string[]): ActivityProgress {
    const old = progress ?? { played_ms: 0, streamed_ms: 0, games: [], last_credit: 0, awards: {} };
    const gap = previous ? current.at - previous.at : 0;
    const elapsed = previous && gap >= 0 && gap <= MAX_ACTIVITY_GAP ? Math.max(0, current.at - Math.max(previous.at, old.last_credit)) : 0;
    const next: ActivityProgress = {
        played_ms: Math.min(MAX_ACTIVITY_TIME, old.played_ms + (previous?.playing ? elapsed : 0)),
        streamed_ms: Math.min(MAX_ACTIVITY_TIME, old.streamed_ms + (previous?.streaming ? elapsed : 0)),
        games: [...new Set([...old.games, ...games])].slice(0, 100),
        last_credit: Math.max(old.last_credit, current.at),
        awards: { ...old.awards },
    };
    for (const [id, definition] of Object.entries(milestones)) {
        if (definition.metric === "account_years") continue;
        const amount = definition.metric === "games" ? next.games.length : next[definition.metric] / 3600000;
        for (const tier of definition.tiers) {
            const threshold = tier.requirements[0].threshold;
            const key = `${id}:${threshold}`;
            if (amount >= threshold && !next.awards[key]) next.awards[key] = new Date(current.at).toISOString();
        }
    }
    return next;
}

export const hasActivityWindow = (id: string) => windows.has(id);

async function recordOnce(id: string) {
    const now = Date.now();
    const [sessions, streams, games] = await Promise.all([
        Session.find({
            where: { user_id: id, is_admin_session: false, last_seen: MoreThan(new Date(now - MAX_ACTIVITY_GAP)), status: Not("offline") },
            select: { activities: true },
        }),
        Stream.find({ where: { owner_id: id } }),
        DetectableGames.load(),
    ]);
    const ids = [
        ...new Set(
            sessions.flatMap((session) =>
                (session.activities ?? []).flatMap((activity) =>
                    activity.type === 0 && activity.application_id && games.byId.has(activity.application_id) ? [activity.application_id] : [],
                ),
            ),
        ),
    ];
    let streaming = false;
    for (const stream of streams) {
        if (
            !GoLiveStreams.isPaused(stream.id) &&
            (await StreamSession.exists({ where: { stream_id: stream.id, user_id: id, used: true } })) &&
            (await GoLiveStreams.viewers(stream)).length > 0
        ) {
            streaming = true;
            break;
        }
    }
    const current = { at: now, playing: ids.length > 0, streaming };
    const previous = windows.get(id);
    if (!previous && !current.playing && !streaming) return;
    const key = ids.length
        ? await (secret ??= activitySecret().catch((error) => {
              secret = undefined;
              throw error;
          }))
        : null;
    const hashes = key ? ids.map((game) => createHmac("sha256", key).update(`${id}:game:${game}`).digest("hex").slice(0, 32)) : [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const user = await User.findOne({ where: { id }, select: { id: true, bot: true, federated_instance: true, account_preferences: true } });
        if (!user || user.bot || user.federated_instance) {
            windows.delete(id);
            return;
        }
        const old = user.account_preferences?.activity_progress;
        const next = advanceActivity(old, previous, current, hashes);
        const postgres = User.getRepository().manager.connection.options.type === "postgres";
        const update = postgres
            ? "UPDATE users SET account_preferences = jsonb_set(COALESCE(account_preferences, '{}'::jsonb), '{activity_progress}', $1::jsonb) WHERE id = $2 AND COALESCE(account_preferences->'activity_progress', 'null'::jsonb) = $3::jsonb RETURNING id"
            : "UPDATE users SET account_preferences = json_set(COALESCE(account_preferences, '{}'), '$.activity_progress', json($1)) WHERE id = $2 AND COALESCE(json_extract(account_preferences, '$.activity_progress'), 'null') = json($3) RETURNING id";
        const rows = await User.query(sqlReturning(update), [JSON.stringify(next), id, JSON.stringify(old ?? null)]);
        if (rows.length) {
            if (current.playing || streaming) windows.set(id, current);
            else windows.delete(id);
            if (Object.keys(next.awards).length > Object.keys(old?.awards ?? {}).length)
                await emitEvent({ event: "USER_UPDATE", user_id: id, data: await User.getPublicUser(id) } as unknown as UserUpdateEvent);
            return;
        }
    }
    throw new Error("activity progress changed concurrently");
}

export function recordActivity(id: string) {
    const work = (pending.get(id) ?? Promise.resolve())
        .catch(() => {})
        .then(() => recordOnce(id))
        .finally(() => {
            if (pending.get(id) === work) pending.delete(id);
        });
    pending.set(id, work);
    return work;
}

ProcessLifecycle.eventEmitter.on("activityProgress", (id: string) => {
    recordActivity(id).catch((error) => console.error("[Activity] progress update failed", error));
});
ProcessLifecycle.eventEmitter.on("stopping", async () => {
    await Promise.allSettled([...windows.keys()].map(recordActivity));
    await Promise.allSettled(pending.values());
    windows.clear();
});
