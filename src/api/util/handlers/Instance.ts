import { isSqlite, sqlForUpdate } from "@spacebar/database/Sql";
import { getDatabase } from "@spacebar/database";
import { ProcessLifecycle } from "../../../util/util/ProcessLifecycle";

let timer: NodeJS.Timeout | undefined;
let pruning: Promise<void> | undefined;
let stopping = false;

export function pruneTemporarySessions() {
    if (stopping) return pruning ?? Promise.resolve();
    if (pruning) return pruning;
    pruning = (async () => {
        const cutoff = new Date(Date.now() - 60 * 60 * 1000);
        await getDatabase()!.query(
            `DELETE FROM "sessions" WHERE "session_id" IN (
                SELECT "session_id" FROM "sessions" WHERE "last_seen" = '${isSqlite() ? "1970-01-01 00:00:00.000" : "1970-01-01 00:00:00"}' AND "created_at" < $1
                ORDER BY "created_at", "session_id" LIMIT 500 ${sqlForUpdate(true)}
            ) AND "last_seen" = '${isSqlite() ? "1970-01-01 00:00:00.000" : "1970-01-01 00:00:00"}' AND "created_at" < $1`,
            [cutoff],
        );
    })().finally(() => {
        pruning = undefined;
    });
    return pruning;
}

export async function initInstance() {
    if (timer || stopping) return;
    timer = setInterval(() => void pruneTemporarySessions().catch((error) => console.error("[Instance] Temporary session cleanup failed", error)), 5 * 60 * 1000);
    timer.unref();
    ProcessLifecycle.eventEmitter.once("stopping", async () => {
        stopping = true;
        clearInterval(timer);
        await Promise.allSettled(pruning ? [pruning] : []);
    });
}
