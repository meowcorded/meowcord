/* SPDX-License-Identifier: AGPL-3.0-only */
import "reflect-metadata";
import { DataSource, getMetadataArgsStorage, SelectQueryBuilder, type DataSourceOptions, type EntityTarget, type ObjectLiteral, type QueryRunner } from "typeorm";
import { BetterSqlite3Driver } from "typeorm/driver/better-sqlite3/BetterSqlite3Driver";
import { BetterSqlite3QueryRunner } from "typeorm/driver/better-sqlite3/BetterSqlite3QueryRunner";
import type { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import type { IsolationLevel } from "typeorm/driver/types/IsolationLevel";
import type { WhereClauseCondition } from "typeorm/query-builder/WhereClause";
import { DateUtils } from "typeorm/util/DateUtils";

type BindValue = string | number | bigint | Uint8Array | null;
type Statement = {
    columnNames: string[];
    all(...parameters: BindValue[]): Record<string, unknown>[];
    run(...parameters: BindValue[]): { changes: number; lastInsertRowid: number | bigint };
};
type NativeDatabase = { prepare(sql: string): Statement; close(): void; exec(sql: string): void };

class BunSqlite {
    private native: NativeDatabase;
    constructor(filename: string) {
        const { Database } = require("bun:sqlite");
        this.native = new Database(filename, { create: true, safeIntegers: true });
        this.native.exec("PRAGMA busy_timeout = 30000");
    }
    prepare(sql: string) {
        const statement = this.native.prepare(sql);
        const normalize = (value: unknown) =>
            typeof value === "bigint" ? (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString()) : value;
        return {
            reader: statement.columnNames.length > 0,
            all: (...parameters: BindValue[]) => statement.all(...parameters).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]))),
            run: (...parameters: BindValue[]) => {
                const result = statement.run(...parameters);
                return { changes: result.changes, lastInsertRowid: normalize(result.lastInsertRowid) };
            },
        };
    }
    pragma(sql: string) {
        return this.prepare(`PRAGMA ${sql}`).all();
    }
    close() {
        this.native.close();
    }
}

class SqliteSelectQueryBuilder<Entity extends ObjectLiteral> extends SelectQueryBuilder<Entity> {
    protected createWhereConditionExpression(condition: WhereClauseCondition, alwaysWrap = false): string {
        if (typeof condition === "object" && !Array.isArray(condition) && "parameters" in condition) {
            const [column, parameter] = condition.parameters;
            if (condition.operator === "arrayContains")
                return `NOT EXISTS (SELECT 1 FROM json_each(${parameter}) expected WHERE NOT EXISTS (SELECT 1 FROM json_each(${column}) actual WHERE actual.value = expected.value))`;
            if (condition.operator === "arrayOverlap")
                return `EXISTS (SELECT 1 FROM json_each(${parameter}) expected JOIN json_each(${column}) actual ON actual.value = expected.value)`;
            if (condition.operator === "arrayContainedBy")
                return `NOT EXISTS (SELECT 1 FROM json_each(${column}) actual WHERE NOT EXISTS (SELECT 1 FROM json_each(${parameter}) expected WHERE actual.value = expected.value))`;
            if (condition.operator === "ilike") return `${column} LIKE ${parameter} ESCAPE '\\'`;
        }
        return super.createWhereConditionExpression(condition, alwaysWrap);
    }
    protected createLockExpression() {
        if (this.expressionMap.lockMode && !this.queryRunner?.isTransactionActive) throw new Error("SQLite row locks require an active transaction");
        return "";
    }
}

export class SqliteDataSource extends DataSource {
    private pending = Promise.resolve();
    constructor(options: Omit<Extract<DataSourceOptions, { type: "better-sqlite3" }>, "type" | "driver">) {
        super({ ...options, type: "better-sqlite3", driver: BunSqlite, enableWAL: true });
        this.driver = new MeowcordSqliteDriver(this);
    }
    async acquire() {
        const previous = this.pending;
        let release!: () => void;
        this.pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        return release;
    }
    createQueryBuilder<Entity extends ObjectLiteral>(entityClass: EntityTarget<Entity>, alias: string, queryRunner?: QueryRunner): SelectQueryBuilder<Entity>;
    createQueryBuilder(queryRunner?: QueryRunner): SelectQueryBuilder<ObjectLiteral>;
    createQueryBuilder<Entity extends ObjectLiteral>(entityOrRunner?: EntityTarget<Entity> | QueryRunner, alias?: string, queryRunner?: QueryRunner): SelectQueryBuilder<Entity> {
        const builder = alias ? super.createQueryBuilder(entityOrRunner as EntityTarget<Entity>, alias, queryRunner) : super.createQueryBuilder(entityOrRunner as QueryRunner);
        return new SqliteSelectQueryBuilder<Entity>(builder);
    }
    protected async buildMetadatas() {
        require("./entities");
        const indexTypes = getMetadataArgsStorage().indices.map((index) => [index, index.type] as const);
        for (const [index] of indexTypes) Object.assign(index, { type: undefined });
        const originals = getMetadataArgsStorage().columns.map((column) => [column, { ...column.options }] as const);
        try {
            for (const [column, original] of originals) {
                const options = { ...original };
                if (
                    column.mode === "regular" &&
                    options.type === "int2" &&
                    getMetadataArgsStorage().generations.some((generation) => generation.target === column.target && generation.propertyName === column.propertyName)
                )
                    options.type = "integer";
                if (options.array) {
                    options.type = "simple-json";
                    options.array = false;
                    if (options.default === "{}") options.default = "[]";
                } else if (options.type === "jsonb") options.type = "simple-json";
                else if (["timestamptz", "timestamp with time zone", "timestamp"].includes(String(options.type))) options.type = "datetime";
                else if (options.type === "character varying") options.type = "varchar";
                else if (options.type === "int4") options.type = "integer";
                else if (options.type === "float8") options.type = "double precision";
                if (typeof options.default === "function" && /^(now\(\)|CURRENT_TIMESTAMP)$/i.test(options.default()))
                    options.default = () => "(strftime('%Y-%m-%d %H:%M:%f', 'now'))";
                Object.assign(column.options, options);
            }
            await super.buildMetadatas();
        } finally {
            for (const [column, options] of originals) Object.assign(column.options, options);
            for (const [index, type] of indexTypes) Object.assign(index, { type });
        }
    }
}

class MeowcordSqliteDriver extends BetterSqlite3Driver {
    createQueryRunner() {
        return new MeowcordSqliteQueryRunner(this);
    }
    isReturningSqlSupported(type?: "insert" | "update" | "delete") {
        return type === "update" || type === "delete";
    }
    prepareHydratedValue(value: unknown, column: ColumnMetadata) {
        if (value !== null && value !== undefined && ["bigint", "int8"].includes(String(column.type))) value = String(value);
        return super.prepareHydratedValue(value, column);
    }
}

class MeowcordSqliteQueryRunner extends BetterSqlite3QueryRunner {
    private unlock?: () => void;
    private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        if (this.unlock) return operation();
        const unlock = await (this.dataSource as SqliteDataSource).acquire();
        try {
            return await operation();
        } finally {
            unlock();
        }
    }
    async startTransaction(isolation?: IsolationLevel) {
        if (this.isTransactionActive) return super.startTransaction(isolation);
        this.unlock = await (this.dataSource as SqliteDataSource).acquire();
        try {
            await super.startTransaction(isolation);
        } catch (error) {
            this.unlock();
            this.unlock = undefined;
            throw error;
        }
    }
    async commitTransaction() {
        try {
            await super.commitTransaction();
        } finally {
            if (!this.isTransactionActive) {
                this.unlock?.();
                this.unlock = undefined;
            }
        }
    }
    async rollbackTransaction() {
        try {
            await super.rollbackTransaction();
        } finally {
            if (!this.isTransactionActive) {
                this.unlock?.();
                this.unlock = undefined;
            }
        }
    }
    async release() {
        while (this.isTransactionActive) await this.rollbackTransaction();
        this.isReleased = true;
    }
    async query(sql: string, parameters: unknown[] = [], structured = false) {
        const bindings: unknown[] = [];
        const query = sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\$(\d+)/g, (token, index) => {
            if (!index) return token;
            bindings.push(parameters[Number(index) - 1]);
            return "?";
        });
        const normalized = (bindings.length ? bindings : parameters).map((value) =>
            value instanceof Date
                ? DateUtils.mixedDateToUtcDatetimeString(value)
                : Array.isArray(value) || (value && typeof value === "object" && !(value instanceof Uint8Array))
                  ? JSON.stringify(value)
                  : value,
        );
        return this.exclusive(async () => {
            const result = await super.query(query === "BEGIN TRANSACTION" ? "BEGIN IMMEDIATE" : query, normalized, structured);
            if (!structured && Array.isArray(result)) {
                const jsonColumns = new Set([
                    "roles",
                    ...this.dataSource.entityMetadatas.flatMap((entity) => entity.columns.filter((column) => column.type === "simple-json").map((column) => column.databaseName)),
                ]);
                for (const row of result) {
                    if (!row || typeof row !== "object") continue;
                    for (const [key, value] of Object.entries(row)) {
                        if (typeof value === "string" && /^[\[{]/.test(value) && jsonColumns.has(key)) row[key] = JSON.parse(value);
                    }
                }
            }
            return result;
        });
    }
}
