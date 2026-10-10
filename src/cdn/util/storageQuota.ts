import { sqlForUpdate } from "@spacebar/database/Sql";
import { HTTPError } from "lambert-server/HTTPError";

interface LedgerRow {
    namespace: string;
    key: string;
    id: string;
    path: string;
    principal: string;
    category: StorageQuotaRequest["category"];
    state: string;
    generation: string;
    pending_operation: string | null;
    bytes: string;
    used_bytes: string;
    reserved_bytes: string;
    used_objects: string;
    reserved_objects: string;
    upper_bytes: string;
    prior_bytes: string;
    prior_exists: boolean;
    prior_generation: string;
    actual_bytes: string | null;
}

export interface QuotaTransaction {
    query(sql: string, parameters?: unknown[]): Promise<LedgerRow[]>;
}
export interface QuotaDatabase {
    transaction<T>(callback: (transaction: QuotaTransaction) => Promise<T>): Promise<T>;
}
export interface StorageQuotaLimits {
    instanceBytes: number;
    principalBytes: number;
    cacheBytes: number;
    instanceObjects: number;
    principalObjects: number;
    cacheObjects: number;
}
export interface StorageQuotaRequest {
    namespace: string;
    id: string;
    path: string;
    principal: string;
    category: "upload" | "managed" | "export" | "cache" | "legacy-unattributed";
    upperBytes: bigint;
}
type Operation = StorageQuotaRequest & {
    priorBytes: bigint;
    priorExists: boolean;
    priorGeneration: string;
    state: string;
    actualBytes?: bigint;
};
const maxInteger = 9223372036854775807n;
function checkedBytes(value: bigint) {
    if (typeof value !== "bigint" || value < 0n || value > maxInteger) throw new HTTPError("Invalid storage byte bound", 400);
    return value;
}
function operation(row: LedgerRow): Operation {
    return {
        namespace: row.namespace,
        id: row.id,
        path: row.path,
        principal: row.principal,
        category: row.category,
        upperBytes: BigInt(row.upper_bytes),
        priorBytes: BigInt(row.prior_bytes),
        priorExists: row.prior_exists,
        priorGeneration: row.prior_generation,
        state: row.state,
        actualBytes: row.actual_bytes === null ? undefined : BigInt(row.actual_bytes),
    };
}

export class StorageQuotaLedger {
    constructor(
        private database: QuotaDatabase,
        private limits: StorageQuotaLimits,
    ) {
        for (const value of [limits.instanceBytes, limits.principalBytes, limits.cacheBytes, limits.instanceObjects, limits.principalObjects, limits.cacheObjects])
            if (!Number.isSafeInteger(value) || value < 1) throw new HTTPError("Invalid storage quota configuration", 503);
    }
    private keys(principal: string, category: string) {
        return ["instance", `principal:${principal}`, ...(category === "cache" ? ["cache"] : [])];
    }
    private async accounts(transaction: QuotaTransaction, namespace: string, principal: string, category: string) {
        const keys = this.keys(principal, category);
        const rows = [];
        for (const key of keys) {
            await transaction.query("INSERT INTO storage_quota_accounts(namespace,key) VALUES($1,$2) ON CONFLICT DO NOTHING", [namespace, key]);
            const [row] = await transaction.query(`SELECT * FROM storage_quota_accounts WHERE namespace=$1 AND key=$2 ${sqlForUpdate()}`, [namespace, key]);
            if (row.state !== "ready") throw new HTTPError("Storage inventory is required before mutations", 503);
            rows.push(row);
        }
        return rows;
    }
    private async counters(
        transaction: QuotaTransaction,
        op: Operation | StorageQuotaRequest,
        usedBytes: bigint,
        reservedBytes: bigint,
        usedObjects: bigint,
        reservedObjects: bigint,
    ) {
        for (const key of this.keys(op.principal, op.category)) {
            await transaction.query(
                `UPDATE storage_quota_accounts SET used_bytes=used_bytes+$3, reserved_bytes=reserved_bytes+$4,
                used_objects=used_objects+$5,reserved_objects=reserved_objects+$6 WHERE namespace=$1 AND key=$2`,
                [op.namespace, key, usedBytes.toString(), reservedBytes.toString(), usedObjects.toString(), reservedObjects.toString()],
            );
        }
    }
    async reserve(request: StorageQuotaRequest): Promise<{ operation: Operation; created: boolean }> {
        checkedBytes(request.upperBytes);
        if (
            !request.namespace ||
            !request.id ||
            !request.path ||
            !/^(user|webhook|application|system):[^\s:]+$/.test(request.principal) ||
            !["upload", "managed", "export", "cache"].includes(request.category)
        )
            throw new HTTPError("Invalid storage ownership", 400);
        if (request.namespace.length > 128 || request.id.length > 128 || request.principal.length > 128 || request.path.length > 2048)
            throw new HTTPError("Invalid storage identity", 400);
        if (!request.path.split("/").every((part) => part && part !== "." && part !== "..") || /[\\\0]/.test(request.path)) throw new HTTPError("Invalid storage path", 400);
        return this.database.transaction(async (transaction) => {
            const accounts = await this.accounts(transaction, request.namespace, request.principal, request.category);
            const [existing] = await transaction.query(`SELECT * FROM storage_quota_operations WHERE namespace=$1 AND id=$2 ${sqlForUpdate()}`, [request.namespace, request.id]);
            if (existing) {
                const op = operation(existing);
                if (op.path !== request.path || op.principal !== request.principal || op.category !== request.category || op.upperBytes !== request.upperBytes)
                    throw new HTTPError("Storage operation identity conflict", 409);
                return { operation: op, created: false };
            }
            const [prior] = await transaction.query(`SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2 ${sqlForUpdate()}`, [request.namespace, request.path]);
            if (prior && (prior.principal !== request.principal || prior.category !== request.category || prior.state !== "live" || prior.pending_operation))
                throw new HTTPError("Storage object ownership or operation conflict", 409);
            for (const account of accounts) {
                const prefix = account.key === "instance" ? "instance" : account.key === "cache" ? "cache" : "principal";
                const bytesLimit = BigInt(this.limits[`${prefix}Bytes`]);
                const objectsLimit = BigInt(this.limits[`${prefix}Objects`]);
                if (
                    BigInt(account.used_bytes) + BigInt(account.reserved_bytes) + request.upperBytes > bytesLimit ||
                    BigInt(account.used_objects) + BigInt(account.reserved_objects) + 1n > objectsLimit
                )
                    throw new HTTPError("Storage quota exceeded", 413);
            }
            const op: Operation = {
                ...request,
                priorBytes: prior ? BigInt(prior.bytes) : 0n,
                priorExists: !!prior,
                priorGeneration: prior?.generation ?? "",
                state: "reserved",
            };
            await transaction.query(
                `INSERT INTO storage_quota_operations(namespace,id,path,principal,category,upper_bytes,prior_bytes,prior_exists,prior_generation)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [op.namespace, op.id, op.path, op.principal, op.category, op.upperBytes.toString(), op.priorBytes.toString(), op.priorExists, op.priorGeneration],
            );
            if (prior) await transaction.query("UPDATE storage_quota_objects SET pending_operation=$3 WHERE namespace=$1 AND path=$2", [op.namespace, op.path, op.id]);
            else
                await transaction.query("INSERT INTO storage_quota_objects(namespace,path,principal,category,generation,pending_operation) VALUES($1,$2,$3,$4,$5,$5)", [
                    op.namespace,
                    op.path,
                    op.principal,
                    op.category,
                    op.id,
                ]);
            await this.counters(transaction, op, 0n, op.upperBytes, 0n, 1n);
            return { operation: op, created: true };
        });
    }
    private async transition(namespace: string, id: string, callback: (transaction: QuotaTransaction, op: Operation, object: LedgerRow | undefined) => Promise<void>) {
        return this.database.transaction(async (transaction) => {
            const [read] = await transaction.query("SELECT * FROM storage_quota_operations WHERE namespace=$1 AND id=$2", [namespace, id]);
            if (!read) throw new HTTPError("Unknown storage operation", 404);
            await this.accounts(transaction, namespace, read.principal, read.category);
            const [row] = await transaction.query(`SELECT * FROM storage_quota_operations WHERE namespace=$1 AND id=$2 ${sqlForUpdate()}`, [namespace, id]);
            const op = operation(row);
            const [object] = await transaction.query(`SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2 ${sqlForUpdate()}`, [namespace, op.path]);
            await callback(transaction, op, object);
        });
    }
    async finalize(namespace: string, id: string, actualBytes: bigint): Promise<void> {
        checkedBytes(actualBytes);
        await this.transition(namespace, id, async (transaction, op, object) => {
            if (op.state === "complete" && op.actualBytes === actualBytes) return;
            if (op.state !== "reserved" || object?.pending_operation !== id) throw new HTTPError("Storage operation conflict", 409);
            if (actualBytes > op.upperBytes) throw new HTTPError("Stored object exceeded reserved bytes", 503);
            await this.counters(transaction, op, actualBytes - op.priorBytes, -op.upperBytes, op.priorExists ? 0n : 1n, -1n);
            await transaction.query("UPDATE storage_quota_objects SET bytes=$3,generation=$4,pending_operation=NULL,state='live' WHERE namespace=$1 AND path=$2", [
                namespace,
                op.path,
                actualBytes.toString(),
                id,
            ]);
            await transaction.query("UPDATE storage_quota_operations SET state='complete',actual_bytes=$3 WHERE namespace=$1 AND id=$2", [namespace, id, actualBytes.toString()]);
        });
    }
    async cancelUnchanged(namespace: string, id: string): Promise<void> {
        await this.transition(namespace, id, async (transaction, op, object) => {
            if (op.state === "cancelled") return;
            if (op.state !== "reserved" || object?.pending_operation !== id) throw new HTTPError("Storage operation conflict", 409);
            await this.counters(transaction, op, 0n, -op.upperBytes, 0n, -1n);
            if (op.priorExists) await transaction.query("UPDATE storage_quota_objects SET pending_operation=NULL WHERE namespace=$1 AND path=$2", [namespace, op.path]);
            else await transaction.query("DELETE FROM storage_quota_objects WHERE namespace=$1 AND path=$2", [namespace, op.path]);
            await transaction.query("UPDATE storage_quota_operations SET state='cancelled' WHERE namespace=$1 AND id=$2", [namespace, id]);
        });
    }
    async deleteConfirmed(namespace: string, path: string, generation: string, remove: () => Promise<void>): Promise<void> {
        const admitted = await this.database.transaction(async (transaction) => {
            const [read] = await transaction.query("SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2", [namespace, path]);
            if (!read) return false;
            await this.accounts(transaction, namespace, read.principal, read.category);
            const [object] = await transaction.query(`SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2 ${sqlForUpdate()}`, [namespace, path]);
            if (!object || object.generation !== generation || object.pending_operation || !["live", "deleting"].includes(object.state))
                throw new HTTPError("Storage operation conflict", 409);
            await transaction.query("UPDATE storage_quota_objects SET state='deleting' WHERE namespace=$1 AND path=$2", [namespace, path]);
            return true;
        });
        if (!admitted) return;
        await remove();
        await this.database.transaction(async (transaction) => {
            const [read] = await transaction.query("SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2", [namespace, path]);
            if (!read) return;
            await this.accounts(transaction, namespace, read.principal, read.category);
            const [object] = await transaction.query(`SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2 ${sqlForUpdate()}`, [namespace, path]);
            if (!object || object.generation !== generation || object.state !== "deleting") throw new HTTPError("Storage operation conflict", 409);
            await this.counters(
                transaction,
                {
                    namespace,
                    principal: object.principal,
                    category: object.category,
                } as StorageQuotaRequest,
                -BigInt(object.bytes),
                0n,
                -1n,
                0n,
            );
            await transaction.query("DELETE FROM storage_quota_objects WHERE namespace=$1 AND path=$2", [namespace, path]);
        });
    }
}
