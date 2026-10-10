/* SPDX-License-Identifier: AGPL-3.0-only */
import type { EntityManager } from "typeorm";

export function databaseBackend(): "postgres" | "sqlite" {
    const scheme = process.env.DATABASE?.split(":", 1)[0] ?? "postgres";
    if (scheme === "sqlite") return "sqlite";
    if (scheme === "postgres" || scheme === "postgresql") return "postgres";
    throw new Error(`Unsupported database backend '${scheme}'. Use postgres: or sqlite:.`);
}

export function sqlitePath(connection: string) {
    if (!connection.startsWith("sqlite:")) throw new Error("SQLite connection strings must start with sqlite:");
    const filename = connection.slice(7);
    if (!filename || (filename.startsWith("//") && !filename.startsWith("///"))) throw new Error("Use sqlite:db/meowcord.sqlite or sqlite:/absolute/path/meowcord.sqlite");
    return filename.startsWith("///") ? filename.slice(2) : filename;
}

export const isSqlite = () => databaseBackend() === "sqlite";
export const sqlNow = () => (isSqlite() ? "strftime('%Y-%m-%d %H:%M:%f', 'now')" : "now()");
export const sqlArrayIncludes = (value: string, array: string) =>
    isSqlite() ? `CAST(${value} AS text) IN (SELECT CAST(value AS text) FROM json_each(${array}))` : `${value} = ANY(${array})`;
export const sqlArrayRemove = (array: string, value: string) =>
    isSqlite() ? `(SELECT json_group_array(value) FROM json_each(${array}) WHERE CAST(value AS text) IS DISTINCT FROM CAST(${value} AS text))` : `array_remove(${array}, ${value})`;
export const sqlLike = (value: string, pattern: string) => (isSqlite() ? `${value} LIKE ${pattern} ESCAPE '\\'` : `${value} ILIKE ${pattern}`);
export const sqlArrayLength = (value: string) => `${isSqlite() ? "json_array_length" : "jsonb_array_length"}(${value})`;
export async function lockTransaction(manager: EntityManager, key: string) {
    if (!isSqlite()) await manager.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}
export const sqlForUpdate = (skipLocked = false) => (isSqlite() ? "" : `FOR UPDATE${skipLocked ? " SKIP LOCKED" : ""}`);
export const sqlArrayAggregate = (value: string, filter?: string) =>
    isSqlite() ? `json_group_array(${value})${filter ? ` FILTER (WHERE ${filter})` : ""}` : `COALESCE(array_agg(${value})${filter ? ` FILTER (WHERE ${filter})` : ""}, '{}')`;
export const sqlGreatest = (...values: string[]) => `${isSqlite() ? "MAX" : "GREATEST"}(${values.join(", ")})`;
export const sqlDayString = (value: string) => (isSqlite() ? `DATE(${value})` : `to_char(${value}, 'YYYY-MM-DD')`);
export function sqlZipArrays(columns: { parameter: string; type: string; name: string }[]) {
    if (!isSqlite()) return `unnest(${columns.map(({ parameter, type }) => `${parameter}::${type}[]`).join(", ")}) AS t(${columns.map(({ name }) => `"${name}"`).join(", ")})`;
    return `(SELECT ${columns.map(({ name, type }, index) => `${type === "bigint" ? `CAST(a${index}.value AS bigint)` : `a${index}.value`} AS "${name}"`).join(", ")}
        FROM json_each(${columns[0].parameter}) a0 ${columns
            .slice(1)
            .map(({ parameter }, index) => `JOIN json_each(${parameter}) a${index + 1} ON a${index + 1}.key = a0.key`)
            .join(" ")}) AS t`;
}
export const sqlReturning = (statement: string) => (isSqlite() ? statement : `WITH returned AS (${statement}) SELECT * FROM returned`);
