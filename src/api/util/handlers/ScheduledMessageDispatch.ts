import { sqlNow, sqlReturning } from "@spacebar/database/Sql";
import { randomUUID } from "node:crypto";
import type { ScheduledMessage } from "@spacebar/database";

export const SCHEDULED_MESSAGE_LEASE_MS = 300_000;

type Query = (sql: string, parameters: unknown[]) => Promise<unknown>;

export async function dispatchClaimedScheduledMessage(query: Query, id: string, send: (message: ScheduledMessage) => Promise<number | null>, onlyDue = false) {
    const token = randomUUID();
    const [scheduled] = (await query(
        sqlReturning(`UPDATE "scheduled_messages" SET "claim_token" = $2, "claim_until" = $3
        WHERE "id" = $1 AND "state" = 0 AND ("claim_until" IS NULL OR "claim_until" <= ${sqlNow()}) ${onlyDue ? `AND "send_at" <= ${sqlNow()}` : ""} RETURNING *`),
        [id, token, new Date(Date.now() + SCHEDULED_MESSAGE_LEASE_MS)],
    )) as ScheduledMessage[];
    if (!scheduled) return false;
    let renewing: Promise<unknown> | undefined;
    const heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = query(`UPDATE "scheduled_messages" SET "claim_until" = $3 WHERE "id" = $1 AND "claim_token" = $2`, [
            id,
            token,
            new Date(Date.now() + SCHEDULED_MESSAGE_LEASE_MS),
        ])
            .catch((error) => console.error(`[ScheduledMessages] failed to renew delivery lease for ${id}`, error))
            .finally(() => {
                renewing = undefined;
            });
    }, SCHEDULED_MESSAGE_LEASE_MS / 3).unref();
    try {
        const failure = await send(scheduled);
        const completed = (await query(
            failure === null
                ? sqlReturning(`DELETE FROM "scheduled_messages" WHERE "id" = $1 AND "claim_token" = $2 RETURNING "id"`)
                : sqlReturning(`UPDATE "scheduled_messages" SET "state" = $3, "claim_token" = NULL, "claim_until" = NULL WHERE "id" = $1 AND "claim_token" = $2 RETURNING "id"`),
            failure === null ? [id, token] : [id, token, failure],
        )) as { id: string }[];
        return failure === null && completed.length > 0;
    } finally {
        clearInterval(heartbeat);
        await renewing;
    }
}
