import { isSqlite } from "@spacebar/database/Sql";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash, randomUUID, Hash } from "node:crypto";
import { HTTPError } from "lambert-server/HTTPError";
import { StorageInventoryReferences, InventoryOwner } from "./storageInventoryReferences";

export interface InventoryConnection {
    connect(): Promise<unknown>;
    release(): Promise<unknown>;
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    startTransaction?(): Promise<void>;
    commitTransaction?(): Promise<void>;
    rollbackTransaction?(): Promise<void>;
}
export interface InventoryDatabase {
    createQueryRunner(): InventoryConnection;
}
export interface InventoryBarrier {
    token: string;
    assertQuiescent(): Promise<void>;
}
export interface InventoryPolicy {
    batchSize: number;
    maxEntries: number;
    maxMetadataFiles: number;
    maxMetadataBytes: number;
}
interface Run {
    namespace: string;
    epoch: string;
    root_identity: string;
    barrier_digest: string;
    state: string;
    phase: string;
    policy: InventoryPolicy;
}
interface Work {
    namespace: string;
    kind: string;
    path: string;
    epoch: string;
    identity: string;
    cursor: string;
    prefix: string;
    state: string;
}
interface Stored {
    principal: string;
    category: string;
    bytes: string;
    generation: string;
    state: string;
    pending_operation: string | null;
}
interface Fingerprint {
    dev: string;
    ino: string;
    bytes: string;
    sha256: string;
}
interface Generation {
    generation: string;
    fingerprint: Fingerprint;
    deleted?: boolean;
}
interface Scan {
    path: string;
    kind: string;
    directory: fs.Dir;
    offset: bigint;
    hash: Hash;
    verified: boolean;
}
export interface InventoryStatus {
    state: string;
    phase: string;
    epoch: string;
    objects: string;
    bytes: string;
    metadataObjects: string;
    metadataBytes: string;
}
const META = ".storage-quota";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const emptyPrefix = digest("");
const fingerprintEqual = (a: Fingerprint, b: Fingerprint) => a.dev === b.dev && a.ino === b.ino && a.bytes === b.bytes && a.sha256 === b.sha256;
const failure = (reason: string) => new HTTPError(`Storage inventory failed (${reason})`, 503);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class LocalStorageInventory {
    private scan: Scan | null = null;
    private root: Promise<string>;
    constructor(
        private database: InventoryDatabase,
        root: string,
        private namespace: string,
        private barrier: InventoryBarrier,
        private policy: InventoryPolicy,
    ) {
        const fields = ["batchSize", "maxEntries", "maxMetadataFiles", "maxMetadataBytes"] as const;
        if (!policy || Object.keys(policy).length !== fields.length || Object.keys(policy).some((key) => !fields.includes(key as (typeof fields)[number])))
            throw failure("INVALID_POLICY");
        for (const field of fields) if (!Number.isSafeInteger(policy[field]) || policy[field] < 1) throw failure("INVALID_POLICY");
        if (
            !Number.isSafeInteger(policy.batchSize) ||
            policy.batchSize > 1024 ||
            policy.maxEntries > 10000000 ||
            policy.maxMetadataFiles > 10000000 ||
            policy.maxMetadataBytes > 1024 * 1024 * 1024
        )
            throw failure("INVALID_POLICY");
        if (!namespace || namespace.length > 128 || !barrier.token) throw failure("INVALID_NAMESPACE");
        this.policy = Object.freeze({ ...policy });
        this.root = this.validateRoot(root);
    }
    private async query<T>(connection: InventoryConnection, sql: string, parameters?: unknown[]): Promise<T[]> {
        return (await connection.query(sql, parameters)) as T[];
    }
    private async validateRoot(root: string) {
        const absolute = resolve(root),
            stat = await fsp.lstat(absolute);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("UNSAFE_ROOT");
        const canonical = await fsp.realpath(absolute);
        const binding = await this.read<{ namespace: string }>(await this.locator(canonical, `${META}/namespace.json`));
        if (binding?.namespace !== this.namespace) throw failure("NAMESPACE_BINDING");
        return canonical;
    }
    private async locator(root: string, path: string) {
        if (path && (path.length > 2048 || /[\\\0]/.test(path) || !path.split("/").every((part) => part && part !== "." && part !== ".."))) throw failure("INVALID_LOCATOR");
        let current = root;
        for (const part of path ? path.split("/") : []) {
            current = join(current, part);
            const stat = await fsp.lstat(current);
            if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw failure("UNSAFE_ENTRY");
        }
        return current;
    }
    private async directoryIdentity(path: string) {
        const stat = await fsp.lstat(path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("UNSAFE_DIRECTORY");
        return JSON.stringify({
            dev: stat.dev.toString(),
            ino: stat.ino.toString(),
            mtime: stat.mtimeNs.toString(),
            ctime: stat.ctimeNs.toString(),
        });
    }
    private async read<T>(path: string): Promise<T | null> {
        let handle;
        try {
            handle = await fsp.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw failure("INVALID_METADATA");
            return JSON.parse(await handle.readFile("utf8")) as T;
        } catch (error) {
            if (absent(error)) return null;
            throw error;
        } finally {
            await handle?.close();
        }
    }
    private async fingerprint(path: string): Promise<Fingerprint> {
        const handle = await fsp.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || before.nlink !== 1n) throw failure("UNSAFE_FILE");
            const hash = createHash("sha256");
            for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
            const after = await handle.stat({ bigint: true });
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
                throw failure("FILE_CHANGED");
            return {
                dev: after.dev.toString(),
                ino: after.ino.toString(),
                bytes: after.size.toString(),
                sha256: hash.digest("hex"),
            };
        } finally {
            await handle.close();
        }
    }
    private async record(path: string, value: unknown) {
        const temporary = `${path}.${randomUUID()}.tmp`,
            handle = await fsp.open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(JSON.stringify(value));
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await fsp.rename(temporary, path);
            const directory = await fsp.open(dirname(path), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        } finally {
            await fsp.unlink(temporary).catch((error) => {
                if (!absent(error)) throw error;
            });
        }
    }
    private async closeScan() {
        if (this.scan) {
            await this.scan.directory.close();
            this.scan = null;
        }
    }
    async close() {
        await this.closeScan();
    }
    private async exclusive<T>(callback: (connection: InventoryConnection) => Promise<T>): Promise<T> {
        const connection = this.database.createQueryRunner();
        await connection.connect();
        let locked = false;
        try {
            const [result] = isSqlite()
                ? (await connection.startTransaction!(), [{ locked: true }])
                : await this.query<{ locked: boolean }>(connection, "SELECT pg_try_advisory_lock(hashtextextended($1,17013)) AS locked", [this.namespace]);
            if (!result.locked) throw new HTTPError("Storage inventory is busy", 409);
            locked = true;
            await this.barrier.assertQuiescent();
            await this.assertNoOperations();
            const resultValue = await callback(connection);
            if (isSqlite()) await connection.commitTransaction!();
            return resultValue;
        } catch (error) {
            await this.closeScan();
            if (locked) {
                await connection
                    .query("UPDATE storage_inventory_runs SET state='failed',error_code='INVENTORY_INTERRUPTED' WHERE namespace=$1 AND state='running'", [this.namespace])
                    .catch(() => {});
            }
            if (error instanceof HTTPError) throw error;
            throw failure("INVENTORY_INTERRUPTED");
        } finally {
            if (locked && !isSqlite()) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,17013))", [this.namespace]).catch(() => {});
            await connection.release();
        }
    }
    private async assertNoOperations() {
        const root = await this.root;
        for (const folder of ["locks", "operations"]) {
            const directory = await fsp.opendir(await this.locator(root, `${META}/${folder}`));
            try {
                if (await directory.read()) throw failure("ADAPTER_RECOVERY_REQUIRED");
            } finally {
                await directory.close();
            }
        }
    }
    private async transaction<T>(connection: InventoryConnection, callback: () => Promise<T>): Promise<T> {
        if (isSqlite()) await connection.startTransaction!();
        else await connection.query("BEGIN");
        try {
            const result = await callback();
            if (isSqlite()) await connection.commitTransaction!();
            else await connection.query("COMMIT");
            return result;
        } catch (error) {
            if (isSqlite()) await connection.rollbackTransaction!();
            else await connection.query("ROLLBACK");
            throw error;
        }
    }
    private async run(connection: InventoryConnection) {
        const [run] = await this.query<Run>(connection, "SELECT * FROM storage_inventory_runs WHERE namespace=$1", [this.namespace]);
        if (!run || run.barrier_digest !== digest(this.barrier.token) || Object.entries(this.policy).some(([key, value]) => run.policy[key as keyof InventoryPolicy] !== value))
            throw failure("EPOCH_CONFLICT");
        const root = await this.root;
        if (run.root_identity !== (await this.directoryIdentity(root))) throw failure("ROOT_CHANGED");
        return run;
    }
    async start(): Promise<InventoryStatus> {
        return this.exclusive(async (connection) => {
            const [existing] = await this.query<Run>(connection, "SELECT * FROM storage_inventory_runs WHERE namespace=$1", [this.namespace]);
            if (existing) {
                await this.run(connection);
                if (existing.state === "failed") await connection.query("UPDATE storage_inventory_runs SET state='running',error_code=NULL WHERE namespace=$1", [this.namespace]);
                return this.status(connection);
            }
            const root = await this.root,
                identity = await this.directoryIdentity(root),
                epoch = randomUUID();
            await this.transaction(connection, async () => {
                const [usage] = await this.query<{ count: string }>(
                    connection,
                    `SELECT CAST(((SELECT COUNT(*) FROM storage_quota_objects WHERE namespace=$1)+(SELECT COUNT(*) FROM storage_quota_operations WHERE namespace=$1)+
     (SELECT COUNT(*) FROM storage_quota_accounts WHERE namespace=$1 AND (used_bytes<>0 OR reserved_bytes<>0 OR used_objects<>0 OR reserved_objects<>0 OR state='ready'))) AS text) AS count`,
                    [this.namespace],
                );
                if (usage.count !== "0") throw failure("EXISTING_LEDGER_REQUIRES_RECONCILIATION");
                await connection.query("INSERT INTO storage_inventory_runs(namespace,epoch,root_identity,barrier_digest,policy) VALUES($1,$2,$3,$4,$5)", [
                    this.namespace,
                    epoch,
                    identity,
                    digest(this.barrier.token),
                    JSON.stringify(this.policy),
                ]);
                for (const key of ["instance", "cache", "principal:system:legacy-unattributed", "principal:system:managed", "principal:system:cache", "principal:system:metadata"])
                    await connection.query("INSERT INTO storage_quota_accounts(namespace,key) VALUES($1,$2) ON CONFLICT DO NOTHING", [this.namespace, key]);
                await connection.query("INSERT INTO storage_inventory_work(namespace,kind,path,epoch,identity,prefix) VALUES($1,'content','',$2,$3,$4)", [
                    this.namespace,
                    epoch,
                    identity,
                    emptyPrefix,
                ]);
            });
            return this.status(connection);
        });
    }
    private references(connection: InventoryConnection) {
        return new StorageInventoryReferences({
            query: (sql, p) => this.query<{ principal: string | null }>(connection, sql, p),
        });
    }
    private async status(connection: InventoryConnection): Promise<InventoryStatus> {
        const run = await this.run(connection);
        const [sum] = await this.query<{
            objects: string;
            bytes: string;
            metadata_objects: string;
            metadata_bytes: string;
        }>(
            connection,
            `SELECT CAST(COUNT(*) AS text) AS objects,CAST(COALESCE(SUM(bytes),0) AS text) AS bytes,
   CAST(COUNT(*) FILTER(WHERE principal='system:metadata') AS text) AS metadata_objects,CAST(COALESCE(SUM(bytes) FILTER(WHERE principal='system:metadata'),0) AS text) AS metadata_bytes
   FROM storage_quota_objects WHERE namespace=$1`,
            [this.namespace],
        );
        return {
            state: run.state,
            phase: run.phase,
            epoch: run.epoch,
            objects: sum.objects,
            bytes: sum.bytes,
            metadataObjects: sum.metadata_objects,
            metadataBytes: sum.metadata_bytes,
        };
    }
    private async importFile(connection: InventoryConnection, run: Run, path: string, metadata: boolean, verify: boolean) {
        const root = await this.root,
            target = await this.locator(root, path),
            fp = await this.fingerprint(target);
        const owner: InventoryOwner = metadata ? { principal: "system:metadata", category: "managed" } : await this.references(connection).resolve(path);
        let generation = `inventory:${run.epoch}:${digest(path)}`;
        if (!metadata) {
            const manifest = await this.locator(root, `${META}/objects`),
                filename = join(manifest, digest(path));
            const prior = await this.read<Generation>(filename);
            if (prior) {
                if (prior.deleted || !prior.fingerprint || !fingerprintEqual(prior.fingerprint, fp) || typeof prior.generation !== "string") throw failure("GENERATION_CONFLICT");
                generation = prior.generation;
            } else {
                if (verify) throw failure("MANIFEST_MISSING");
                await this.record(filename, { generation, fingerprint: fp });
            }
        }
        const fingerprintKind = metadata ? "metadata-fingerprint" : "content-fingerprint";
        const [knownFingerprint] = await this.query<Work>(connection, "SELECT * FROM storage_inventory_work WHERE namespace=$1 AND kind=$2 AND path=$3", [
            this.namespace,
            fingerprintKind,
            path,
        ]);
        if (knownFingerprint && knownFingerprint.identity !== JSON.stringify(fp)) throw failure("FILE_CHANGED");
        if (verify && !knownFingerprint) throw failure("FINGERPRINT_MISSING");
        const [prior] = await this.query<Stored>(connection, "SELECT * FROM storage_quota_objects WHERE namespace=$1 AND path=$2", [this.namespace, path]);
        if (prior) {
            if (
                prior.bytes !== fp.bytes ||
                prior.principal !== owner.principal ||
                prior.category !== owner.category ||
                prior.generation !== generation ||
                prior.state !== "inventoried" ||
                prior.pending_operation
            )
                throw failure("OBJECT_CONFLICT");
            return;
        }
        if (verify) throw failure("OBJECT_MISSING");
        await this.transaction(connection, async () => {
            const [count] = await this.query<{
                count: string;
                metadata_count: string;
                metadata_bytes: string;
            }>(
                connection,
                `SELECT CAST(COUNT(*) AS text) AS count,CAST(COUNT(*) FILTER(WHERE principal='system:metadata') AS text) AS metadata_count,
    CAST(COALESCE(SUM(bytes) FILTER(WHERE principal='system:metadata'),0) AS text) AS metadata_bytes FROM storage_quota_objects WHERE namespace=$1`,
                [this.namespace],
            );
            if (
                BigInt(count.count) >= BigInt(this.policy.maxEntries) ||
                (metadata &&
                    (BigInt(count.metadata_count) >= BigInt(this.policy.maxMetadataFiles) ||
                        BigInt(count.metadata_bytes) + BigInt(fp.bytes) > BigInt(this.policy.maxMetadataBytes)))
            )
                throw failure("INVENTORY_BOUND");
            await connection.query(
                "INSERT INTO storage_inventory_work(namespace,kind,path,epoch,identity,prefix,state) VALUES($1,$2,$3,$4,$5,$6,'complete') ON CONFLICT DO NOTHING",
                [this.namespace, fingerprintKind, path, run.epoch, JSON.stringify(fp), emptyPrefix],
            );
            await connection.query("INSERT INTO storage_quota_objects(namespace,path,principal,category,bytes,generation,state) VALUES($1,$2,$3,$4,$5,$6,'inventoried')", [
                this.namespace,
                path,
                owner.principal,
                owner.category,
                fp.bytes,
                generation,
            ]);
            for (const key of ["instance", `principal:${owner.principal}`, ...(owner.category === "cache" ? ["cache"] : [])]) {
                await connection.query("INSERT INTO storage_quota_accounts(namespace,key) VALUES($1,$2) ON CONFLICT DO NOTHING", [this.namespace, key]);
                await connection.query("UPDATE storage_quota_accounts SET used_bytes=used_bytes+$3,used_objects=used_objects+1 WHERE namespace=$1 AND key=$2", [
                    this.namespace,
                    key,
                    fp.bytes,
                ]);
            }
        });
    }
    private async advancePhase(connection: InventoryConnection, run: Run) {
        await this.closeScan();
        if (run.phase === "content" || run.phase === "metadata") {
            const phase = run.phase === "content" ? "verify" : "metadata-verify";
            await this.transaction(connection, async () => {
                await connection.query("UPDATE storage_inventory_work SET cursor=0,prefix=$3,state='pending' WHERE namespace=$1 AND kind=$2", [
                    this.namespace,
                    run.phase,
                    emptyPrefix,
                ]);
                await connection.query("UPDATE storage_inventory_runs SET phase=$2 WHERE namespace=$1", [this.namespace, phase]);
            });
            return;
        }
        if (run.phase === "verify") {
            const identity = await this.directoryIdentity(await this.locator(await this.root, META));
            await this.transaction(connection, async () => {
                await connection.query("INSERT INTO storage_inventory_work(namespace,kind,path,epoch,identity,prefix) VALUES($1,'metadata',$2,$3,$4,$5)", [
                    this.namespace,
                    META,
                    run.epoch,
                    identity,
                    emptyPrefix,
                ]);
                await connection.query("UPDATE storage_inventory_runs SET phase='metadata' WHERE namespace=$1", [this.namespace]);
            });
            return;
        }
        if (run.phase !== "metadata-verify") throw failure("INVALID_PHASE");
        await this.barrier.assertQuiescent();
        await this.assertNoOperations();
        await this.transaction(connection, async () => {
            const [pending] = await this.query<{ count: string }>(
                connection,
                `SELECT CAST(COUNT(*) AS text) AS count FROM storage_inventory_work WHERE namespace=$1 AND state<>'complete'`,
                [this.namespace],
            );
            if (pending.count !== "0") throw failure("INCOMPLETE_WORK");
            await connection.query("UPDATE storage_quota_accounts SET state='inventory-complete' WHERE namespace=$1", [this.namespace]);
            await connection.query("UPDATE storage_inventory_runs SET state='inventory-complete',phase='complete',completed_at=CURRENT_TIMESTAMP WHERE namespace=$1", [
                this.namespace,
            ]);
        });
    }
    async step(): Promise<InventoryStatus> {
        return this.exclusive(async (connection) => {
            const run = await this.run(connection);
            if (run.state === "inventory-complete") return this.status(connection);
            if (run.state !== "running") throw failure("RESUME_REQUIRED");
            const metadata = run.phase === "metadata" || run.phase === "metadata-verify",
                verify = run.phase === "verify" || run.phase === "metadata-verify",
                kind = metadata ? "metadata" : "content";
            const [work] = await this.query<Work>(connection, "SELECT * FROM storage_inventory_work WHERE namespace=$1 AND kind=$2 AND state='pending' ORDER BY path LIMIT 1", [
                this.namespace,
                kind,
            ]);
            if (!work) {
                await this.advancePhase(connection, run);
                return this.status(connection);
            }
            const directory = await this.locator(await this.root, work.path);
            if (work.identity !== (await this.directoryIdentity(directory)) || work.epoch !== run.epoch) throw failure("DIRECTORY_CHANGED");
            if (!this.scan || this.scan.path !== work.path || this.scan.kind !== kind) {
                await this.closeScan();
                this.scan = {
                    path: work.path,
                    kind,
                    directory: await fsp.opendir(directory, { bufferSize: this.policy.batchSize }),
                    offset: 0n,
                    hash: createHash("sha256"),
                    verified: work.cursor === "0",
                };
            }
            const scan = this.scan;
            let ended = false;
            for (let used = 0; used < this.policy.batchSize; used++) {
                const entry = await scan.directory.read();
                if (!entry) {
                    ended = true;
                    break;
                }
                scan.hash.update(JSON.stringify([entry.name, entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"]) + "\n");
                scan.offset++;
                if (!scan.verified) {
                    if (scan.offset === BigInt(work.cursor)) {
                        if (scan.hash.copy().digest("hex") !== work.prefix) throw failure("CHECKPOINT_CHANGED");
                        scan.verified = true;
                    }
                    continue;
                }
                const child = work.path ? `${work.path}/${entry.name}` : entry.name;
                if (!metadata && !work.path && entry.name === META) continue;
                const filename = await this.locator(await this.root, child);
                if (entry.isDirectory()) {
                    if (!verify) {
                        const identity = await this.directoryIdentity(filename);
                        const [count] = await this.query<{ count: string }>(connection, `SELECT CAST(COUNT(*) AS text) AS count FROM storage_inventory_work WHERE namespace=$1`, [
                            this.namespace,
                        ]);
                        if (BigInt(count.count) >= BigInt(this.policy.maxEntries)) throw failure("DIRECTORY_BOUND");
                        await connection.query("INSERT INTO storage_inventory_work(namespace,kind,path,epoch,identity,prefix) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
                            this.namespace,
                            kind,
                            child,
                            run.epoch,
                            identity,
                            emptyPrefix,
                        ]);
                    } else {
                        const [known] = await this.query<Work>(connection, "SELECT * FROM storage_inventory_work WHERE namespace=$1 AND kind=$2 AND path=$3", [
                            this.namespace,
                            kind,
                            child,
                        ]);
                        if (!known || known.identity !== (await this.directoryIdentity(filename))) throw failure("DIRECTORY_CHANGED");
                    }
                } else if (entry.isFile()) await this.importFile(connection, run, child, metadata, verify);
                else throw failure("UNSUPPORTED_ENTRY");
            }
            if (work.identity !== (await this.directoryIdentity(directory))) throw failure("DIRECTORY_CHANGED");
            if (ended && !scan.verified) throw failure("CHECKPOINT_CHANGED");
            if (scan.verified)
                await connection.query("UPDATE storage_inventory_work SET cursor=$4,prefix=$5,state=$6 WHERE namespace=$1 AND kind=$2 AND path=$3", [
                    this.namespace,
                    kind,
                    work.path,
                    scan.offset.toString(),
                    scan.hash.copy().digest("hex"),
                    ended ? "complete" : "pending",
                ]);
            if (ended) await this.closeScan();
            return this.status(connection);
        });
    }
    async provision(principal: string): Promise<void> {
        await this.exclusive(async (connection) => {
            const run = await this.run(connection);
            if (run.state !== "inventory-complete") throw failure("INVENTORY_INCOMPLETE");
            if (!(await this.references(connection).persistedPrincipal(principal))) throw failure("UNTRUSTED_PRINCIPAL");
            await connection.query("INSERT INTO storage_quota_accounts(namespace,key,state) VALUES($1,$2,'inventory-complete') ON CONFLICT DO NOTHING", [
                this.namespace,
                `principal:${principal}`,
            ]);
        });
    }
}
