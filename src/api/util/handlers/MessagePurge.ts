import { sqlForUpdate, sqlNow, sqlReturning } from "@spacebar/database/Sql";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";
import { getDatabase } from "@spacebar/database";
import { GUILD_VERSION_HORIZON } from "@spacebar/util";

const BATCH = 500;
let stopping = false;
let workerTimer: NodeJS.Timeout | undefined;
let running: Promise<void> | null = null;
let again = false;
let prunedAt = 0;

async function drain() {
    const db = getDatabase()!;
    if (Date.now() - prunedAt > 60 * 60 * 1000) {
        prunedAt = Date.now();
        await db.query(`DELETE FROM "guild_entity_deletes" WHERE "version" < $1`, [Date.now() - GUILD_VERSION_HORIZON]);
    }
    while (!stopping) {
        const processed = await db.transaction(async (manager) => {
            const [next] = (await manager.query(`SELECT "channel_id" FROM "message_purges" ORDER BY "created_at", "channel_id" LIMIT 1 ${sqlForUpdate(true)}`)) as {
                channel_id: string;
            }[];
            if (!next) return false;
            const deleted = (await manager.query(
                sqlReturning(`DELETE FROM "messages" WHERE "id" IN (SELECT "id" FROM "messages" WHERE "channel_id" = $1 LIMIT ${BATCH}) RETURNING id`),
                [next.channel_id],
            )) as { id: string }[];
            const count = deleted.length;
            if (count >= BATCH) await manager.query(`UPDATE "message_purges" SET "created_at" = ${sqlNow()} WHERE "channel_id" = $1`, [next.channel_id]);
            else await manager.query(`DELETE FROM "message_purges" WHERE "channel_id" = $1`, [next.channel_id]);
            return true;
        });
        if (!processed) return;
        await new Promise<void>((resolve) => void setImmediate(resolve));
    }
}

export function purgeDeletedChannels() {
    if (stopping) return running ?? Promise.resolve();
    if (running) {
        again = true;
        return running;
    }
    running = (async () => {
        do {
            again = false;
            await drain();
        } while (again && !stopping);
    })()
        .catch((e) => console.error("[MessagePurge] failed to purge messages of deleted channels", e))
        .finally(() => {
            running = null;
        });
    return running;
}

export function startMessagePurger() {
    if (workerTimer || stopping) return workerTimer;
    const run = () => purgeDeletedChannels().catch((error) => console.error("[MessagePurge] failed to purge messages of deleted channels", error));
    const initial = setTimeout(run, 5_000);
    workerTimer = setInterval(run, 60_000);
    ProcessLifecycle.eventEmitter.once("stopping", async () => {
        stopping = true;
        clearTimeout(initial);
        clearInterval(workerTimer);
        await Promise.allSettled(running ? [running] : []);
    });
    return workerTimer;
}
