import path from "node:path";
import fs from "node:fs";
import { green, red, yellow } from "picocolors";
import { DataSource, MigrationExecutor, type QueryRunner } from "typeorm";
import { ProcessLifecycle } from "../util/util/ProcessLifecycle";
import { SqliteDataSource } from "./SqliteDataSource";
import { databaseBackend, sqlitePath } from "./Sql";

// UUID extension option is only supported with postgres
// We want to generate all id's with Snowflakes that's why we have our own BaseEntity class

export let dbConnection: DataSource | undefined;

let databaseInitialization: Promise<DataSource> | undefined;
let shutdownHandlerRegistered = false;

let isHeadlessProcess = false;
// For typeorm cli
if (!process.env) isHeadlessProcess = true;
if (process.argv[1]?.endsWith("scripts/openapi.js")) isHeadlessProcess = true;

if (!process.env.DATABASE && !isHeadlessProcess) {
    console.log(
        red(
            "DATABASE environment variable not set! Please set it to your database connection string.\n" +
                "Examples: postgres://user:password@localhost:5432/database or sqlite:db/meowcord.sqlite",
        ),
    );
    process.exit(1);
}

export const DatabaseType = databaseBackend();
const applyMigrations = process.env.APPLY_DB_MIGRATIONS !== "false";
const MIGRATIONLOCK = 1;
const commonOptions = {
    entities: [path.join(__dirname, "entities", "*.js")],
    synchronize: process.env.DB_SYNC === "true",
    logging: process.env.DB_LOGGING === "true",
    migrations: applyMigrations ? [path.join(__dirname, "migration", DatabaseType, "*.js")] : [],
    invalidWhereValuesBehavior: { null: "sql-null" as const, undefined: "ignore" as const },
};
export const DataSourceOptions = isHeadlessProcess
    ? (undefined as unknown as DataSource)
    : DatabaseType === "sqlite"
      ? new SqliteDataSource({ ...commonOptions, database: sqlitePath(process.env.DATABASE!) })
      : new DataSource({
            ...commonOptions,
            type: "postgres",
            url: process.env.DATABASE,
            connectTimeoutMS: 30000,
            poolSize: Number(process.env.DB_POOL_SIZE) || 20,
        });

// Gets the existing database connection
export function getDatabase(): DataSource | null {
    // if (!dbConnection) throw new Error("Tried to get database before it was initialised");
    if (!dbConnection) return null;
    return dbConnection;
}

// Called once on server start
export function initDatabase(): Promise<DataSource> {
    if (databaseInitialization) return databaseInitialization;
    if (dbConnection?.isInitialized) return Promise.resolve(dbConnection);
    databaseInitialization = initializeDatabase()
        .catch(async (error) => {
            dbConnection = undefined;
            if (DataSourceOptions.isInitialized)
                await DataSourceOptions.destroy().catch((cleanupError) => console.error("[Database] Failed to close database after initialization failure", cleanupError));
            throw error;
        })
        .finally(() => {
            databaseInitialization = undefined;
        });
    return databaseInitialization;
}

const databaseErrorCode = (error: unknown) => {
    const failure = error as { code?: string; driverError?: { code?: string } };
    return failure?.driverError?.code ?? failure?.code;
};

async function initializeDatabase(): Promise<DataSource> {
    if (!process.env.DB_SYNC) {
        const supported = ["postgres", "sqlite"];
        if (!supported.includes(DatabaseType)) {
            console.log(
                "[Database]" +
                    red(
                        ` We don't have migrations for DB type '${DatabaseType}'` +
                            ` To ignore, set DB_SYNC=true in your env. https://docs.spacebar.chat/setup/server/configuration/env/`,
                    ),
            );
            process.exit(1);
        }
    }

    console.log(`[Database] ${yellow(`Connecting to ${DatabaseType} db`)}`);

    let retries = 0;
    do {
        try {
            dbConnection = await DataSourceOptions.initialize();
        } catch (error) {
            const code = databaseErrorCode(error);
            if (
                !code ||
                !(
                    code.startsWith("08") ||
                    ["57P01", "57P02", "57P03", "53300", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "EAI_AGAIN"].includes(code)
                )
            )
                throw error;
            console.error("[Database] Could not connect to database after", retries, "retries:", error);
        }
    } while (!dbConnection && retries++ < 10);

    if (!dbConnection) throw new Error("[Database] FATAL: Could not connect to database!");

    // Crude way of detecting if the migrations table exists.
    const dbExists = async (queryRunner?: QueryRunner) => {
        if (DatabaseType === "sqlite") {
            const rows = await (queryRunner ?? dbConnection!).query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config'");
            return rows.length > 0;
        }
        try {
            // do not globally import to avoid circular references
            await require("./entities/Config").ConfigEntity.count();
            return true;
        } catch (error) {
            if (databaseErrorCode(error) === "42P01") return false;
            throw error;
        }
    };
    if (applyMigrations) {
        const qr = dbConnection.createQueryRunner();
        let migrationLockAcquired = false;
        try {
            if (DatabaseType === "sqlite") await qr.startTransaction();
            if (DatabaseType === "postgres") {
                await qr.query(`Select pg_advisory_lock(${MIGRATIONLOCK})`);
                migrationLockAcquired = true;
            }
            if (!(await dbExists(qr))) {
                console.log("[Database] This appears to be a fresh database. Running initial DDL.");
                const initialPath = path.join(__dirname, "migration", DatabaseType + "-initial.js");
                if (fs.existsSync(initialPath)) {
                    console.log("[Database] Found initial migration file, running it.");
                    await new (require(`./migration/${DatabaseType}-initial`).initial0)().up(qr);
                } else console.log("[Database] No initial migration file found at '", initialPath, "', skipping.");
            }
            console.log("[Database] Applying missing migrations, if any.", process.env.APPLY_DB_MIGRATIONS);
            if (DatabaseType === "sqlite") {
                await new MigrationExecutor(dbConnection, qr).executePendingMigrations();
                await qr.commitTransaction();
            } else await dbConnection.runMigrations();
        } finally {
            try {
                if (qr.isTransactionActive) await qr.rollbackTransaction();
                if (migrationLockAcquired) await qr.query(`Select pg_advisory_unlock(${MIGRATIONLOCK})`);
            } finally {
                await qr.release();
            }
        }
    } else {
        console.log("[Database] Skipping migrations as per config.");
        while (!(await dbExists())) {
            console.log("[Database] Database does not exist, and we are not running migrations... Waiting 1 seconds...");
            await new Promise((r) => void setTimeout(r, 5000));
        }
    }

    if (!shutdownHandlerRegistered) {
        ProcessLifecycle.eventEmitter.on("stopped", async () => await closeDatabase());
        shutdownHandlerRegistered = true;
    }

    console.log(`[Database] ${green("Connected")}`);
    return dbConnection;
}

export async function closeDatabase() {
    if (DataSourceOptions.isInitialized) await DataSourceOptions.destroy();
    if (dbConnection?.isInitialized) await dbConnection?.destroy();
    dbConnection = undefined;
}
