import { isSqlite } from "@spacebar/database/Sql";
// Copyright Spacebar & contributors 2026 (AGPLv3)
import { createHash, randomUUID } from "node:crypto";
import { HTTPError } from "lambert-server/HTTPError";
import { QueryRunner } from "typeorm";
import { getDatabase } from "../../database/Database";
import { Config } from "../../util/util/Config";
import { Storage, StorageRead } from "./Storage";
import { storageOwnership } from "./storageOwnership";
import { StorageInventoryReferences } from "./storageInventoryReferences";

interface StoredObject {
    path: string;
    principal: string;
    category: string;
    budget_principal: string;
    bytes: string;
    reserved_bytes: string;
    pending: boolean;
    operation_generation: string;
}
export interface InventoryStorage extends Storage {
    inventory(): AsyncIterable<{ path: string; size: number; generation?: string }>;
    remoteGenerationConfirmation?: boolean;
}

export class QuotaStorage implements Storage {
    private initialized?: Promise<void>;
    private namespace: string;
    constructor(
        private backend: InventoryStorage,
        identity: string,
    ) {
        this.namespace = createHash("sha256").update(identity).digest("hex");
    }
    private validate(path: string) {
        if (!path || path.length > 2048 || /[\\\0]/.test(path) || !path.split("/").every((part) => part && part !== "." && part !== ".."))
            throw new HTTPError("Invalid storage path", 400);
    }
    private async exclusive<T>(callback: (runner: QueryRunner) => Promise<T>): Promise<T> {
        const database = getDatabase();
        if (!database) throw new HTTPError("Storage database unavailable", 503);
        const runner = database.createQueryRunner();
        await runner.connect();
        try {
            if (!isSqlite()) await runner.query("SELECT pg_advisory_lock(hashtextextended($1,17014))", [this.namespace]);
            else await runner.startTransaction();
            const result = await callback(runner);
            if (isSqlite()) await runner.commitTransaction();
            return result;
        } finally {
            if (!isSqlite()) await runner.query("SELECT pg_advisory_unlock(hashtextextended($1,17014))", [this.namespace]).catch(() => {});
            await runner.release();
        }
    }
    initialize(): Promise<void> {
        this.initialized ??= this.exclusive(async (runner) => {
            await runner.startTransaction();
            try {
                await runner.query(
                    isSqlite()
                        ? "CREATE TEMP TABLE IF NOT EXISTS storage_runtime_inventory(path varchar(2048) PRIMARY KEY)"
                        : "CREATE TEMP TABLE storage_runtime_inventory(path varchar(2048) PRIMARY KEY) ON COMMIT DROP",
                );
                if (isSqlite()) await runner.query("DELETE FROM storage_runtime_inventory");
                const references = new StorageInventoryReferences({ query: (sql, parameters) => runner.query(sql, parameters) });
                let count = 0;
                for await (const object of this.backend.inventory()) {
                    this.validate(object.path);
                    if (!Number.isSafeInteger(object.size) || object.size < 0 || ++count > 10000000) throw new HTTPError("Storage inventory exceeds safety bounds", 503);
                    const [known] = await runner.query("SELECT * FROM storage_runtime_objects WHERE namespace=$1 AND path=$2", [this.namespace, object.path]);
                    const uncertain = this.backend.remoteGenerationConfirmation && known?.pending && object.generation !== known.operation_generation;
                    const owner = known ?? (await references.resolve(object.path));
                    const budget = known?.budget_principal ?? (await this.budgetPrincipal(runner, owner.principal));
                    await runner.query(
                        `INSERT INTO storage_runtime_objects(namespace,path,principal,category,bytes,budget_principal) VALUES($1,$2,$3,$4,$5,$6)
                        ON CONFLICT(namespace,path) DO UPDATE SET bytes=$5,reserved_bytes=$7,pending=$8`,
                        [
                            this.namespace,
                            object.path,
                            owner.principal,
                            owner.category,
                            uncertain ? Math.max(Number(known.bytes), object.size) : object.size,
                            budget,
                            uncertain ? known.reserved_bytes : 0,
                            !!uncertain,
                        ],
                    );
                    await runner.query("INSERT INTO storage_runtime_inventory(path) VALUES($1)", [object.path]);
                }
                await runner.query(
                    `DELETE FROM storage_runtime_objects WHERE namespace=$1 AND path NOT IN (SELECT path FROM storage_runtime_inventory) ${this.backend.remoteGenerationConfirmation ? "AND NOT pending" : ""}`,
                    [this.namespace],
                );
                await runner.commitTransaction();
            } catch (error) {
                await runner.rollbackTransaction();
                throw error;
            }
        });
        return this.initialized;
    }
    private async owner(runner: QueryRunner, path: string, source?: StoredObject) {
        if (source) return { principal: source.principal, category: source.category };
        const actor = storageOwnership.getStore();
        const references = new StorageInventoryReferences({ query: (sql, parameters) => runner.query(sql, parameters) });
        const resolved = await references.resolve(path);
        if (resolved.category === "cache") return resolved;
        if (actor) {
            if (actor !== "system:cache" && !(await references.persistedPrincipal(actor))) throw new HTTPError("Invalid storage owner", 403);
            return { principal: actor, category: actor === "system:cache" ? "cache" : path.startsWith("harvests/") ? "export" : "upload" };
        }
        const owner = resolved;
        if (owner.category === "legacy-unattributed") return { principal: "system:managed", category: "managed" };
        return owner;
    }
    private async budgetPrincipal(runner: QueryRunner, principal: string): Promise<string> {
        const [type, id] = principal.split(":");
        if (type !== "webhook" && type !== "application") return principal;
        const table = type === "webhook" ? "webhooks" : "applications";
        const column = type === "webhook" ? "user_id" : "owner_id";
        const [owner] = await runner.query(`SELECT ${column} AS owner_id FROM ${table} WHERE id=$1`, [id]);
        return owner?.owner_id ? `user:${owner.owner_id}` : principal;
    }
    private async object(runner: QueryRunner, path: string): Promise<StoredObject | undefined> {
        const [row] = await runner.query("SELECT * FROM storage_runtime_objects WHERE namespace=$1 AND path=$2", [this.namespace, path]);
        if (row?.pending) throw new HTTPError("Storage operation requires restart reconciliation", 503);
        return row;
    }
    private async reserve(runner: QueryRunner, path: string, bytes: number, source?: StoredObject) {
        this.validate(path);
        const prior = await this.object(runner, path);
        const owner = prior ?? (await this.owner(runner, path, source));
        if (prior && source && (prior.principal !== source.principal || prior.category !== source.category)) throw new HTTPError("Storage ownership conflict", 409);
        const budget = prior?.budget_principal ?? source?.budget_principal ?? (await this.budgetPrincipal(runner, owner.principal));
        const limits = Config.get().cdn.storageQuota;
        for (const prefix of ["instance", "principal", ...(owner.category === "cache" ? ["cache"] : [])] as ("instance" | "principal" | "cache")[]) {
            const byteLimit = limits[`${prefix}Bytes`],
                objectLimit = limits[`${prefix}Objects`];
            if (!Number.isSafeInteger(byteLimit) || byteLimit < 1 || !Number.isSafeInteger(objectLimit) || objectLimit < 1) throw new HTTPError("Invalid storage quota", 503);
            const [usage] = await runner.query(
                `SELECT CAST(COALESCE(SUM(bytes+reserved_bytes),0) AS text) AS bytes,CAST(COUNT(*) AS text) AS objects FROM storage_runtime_objects
                WHERE namespace=$1 ${prefix === "principal" ? "AND budget_principal=$2" : prefix === "cache" ? "AND category='cache'" : ""}`,
                prefix === "principal" ? [this.namespace, budget] : [this.namespace],
            );
            if (BigInt(usage.bytes) + BigInt(bytes) > BigInt(byteLimit) || BigInt(usage.objects) + (prior ? 0n : 1n) > BigInt(objectLimit))
                throw new HTTPError("Storage quota exceeded", 413);
        }
        const generation = randomUUID();
        await runner.query(
            `INSERT INTO storage_runtime_objects(namespace,path,principal,category,reserved_bytes,pending,budget_principal,operation_generation) VALUES($1,$2,$3,$4,$5,true,$6,$7)
            ON CONFLICT(namespace,path) DO UPDATE SET reserved_bytes=$5,pending=true,operation_generation=$7`,
            [this.namespace, path, owner.principal, owner.category, bytes, budget, generation],
        );
        return generation;
    }
    private async confirm(runner: QueryRunner, path: string, generation?: string) {
        const read = await this.backend.openRead!(path);
        if (this.backend.remoteGenerationConfirmation && generation && read?.generation !== generation) {
            read?.stream.destroy();
            throw new HTTPError("Storage generation requires reconciliation", 503);
        }
        if (!read) {
            await runner.query("DELETE FROM storage_runtime_objects WHERE namespace=$1 AND path=$2", [this.namespace, path]);
            return;
        }
        read.stream.destroy();
        await runner.query("UPDATE storage_runtime_objects SET bytes=$3,reserved_bytes=0,pending=false WHERE namespace=$1 AND path=$2", [this.namespace, path, read.size]);
    }
    async set(path: string, data: Buffer, principal?: string): Promise<void> {
        if (principal) return storageOwnership.run(principal, () => this.set(path, data));
        await this.initialize();
        await this.exclusive(async (runner) => {
            const generation = await this.reserve(runner, path, data.length);
            try {
                await this.backend.set(path, data, undefined, generation);
                await this.confirm(runner, path, generation);
            } catch (error) {
                if (!this.backend.remoteGenerationConfirmation) await this.confirm(runner, path).catch(() => {});
                throw error;
            }
        });
    }
    async clone(path: string, destination: string) {
        this.validate(path);
        await this.initialize();
        await this.exclusive(async (runner) => {
            const source = await this.object(runner, path);
            if (!source) throw new HTTPError("Storage source not found", 404);
            const generation = await this.reserve(runner, destination, Number(source.bytes), source);
            try {
                await this.backend.clone(path, destination, generation);
                await this.confirm(runner, destination, generation);
            } catch (error) {
                if (!this.backend.remoteGenerationConfirmation) await this.confirm(runner, destination).catch(() => {});
                throw error;
            }
        });
    }
    async move(path: string, destination: string) {
        if (path === destination) return;
        this.validate(path);
        await this.initialize();
        await this.exclusive(async (runner) => {
            const source = await this.object(runner, path);
            if (!source) throw new HTTPError("Storage source not found", 404);
            const generation = await this.reserve(runner, destination, Number(source.bytes), source);
            try {
                await this.backend.clone(path, destination, generation);
                await this.confirm(runner, destination, generation);
                await runner.query("UPDATE storage_runtime_objects SET pending=true WHERE namespace=$1 AND path=$2", [this.namespace, path]);
                await this.backend.delete(path);
                await this.confirm(runner, path);
            } catch (error) {
                if (!this.backend.remoteGenerationConfirmation) await this.confirm(runner, destination).catch(() => {});
                if (!this.backend.remoteGenerationConfirmation) await this.confirm(runner, path).catch(() => {});
                throw error;
            }
        });
    }
    async delete(path: string) {
        this.validate(path);
        await this.initialize();
        await this.exclusive(async (runner) => {
            await this.object(runner, path);
            await runner.query("UPDATE storage_runtime_objects SET pending=true WHERE namespace=$1 AND path=$2", [this.namespace, path]);
            try {
                await this.backend.delete(path);
                await this.confirm(runner, path);
            } catch (error) {
                if (!this.backend.remoteGenerationConfirmation) await this.confirm(runner, path).catch(() => {});
                throw error;
            }
        });
    }
    openRead(path: string, signal?: AbortSignal): Promise<StorageRead | null> {
        return this.backend.openRead!(path, signal);
    }
    get(path: string) {
        return this.backend.get(path);
    }
    exists(path: string) {
        return this.backend.exists(path);
    }
    isFile(path: string) {
        return this.backend.isFile(path);
    }
}
