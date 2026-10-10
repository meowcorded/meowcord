/* SPDX-License-Identifier: AGPL-3.0-only */
import { Client } from "pg";
import { pathToFileURL } from "node:url";

export async function setOperator(client, action, id) {
    if (!["grant", "revoke"].includes(action) || !/^[1-9][0-9]{0,19}$/.test(id || "")) throw new Error("Usage: bun scripts/ops/operator.mjs <grant|revoke> <account-id>");
    await client.query("BEGIN");
    try {
        const result = await client.query("SELECT id, rights, bot, disabled, deleted FROM users WHERE id = $1 FOR UPDATE", [id]);
        const account = result.rows[0];
        if (!account) throw new Error("Account does not exist");
        if (action === "grant" && (account.bot || account.disabled || account.deleted)) throw new Error("Only an active human account can receive operator rights");
        const rights = BigInt(account.rights);
        if (rights < 0n) throw new Error("Account has invalid rights");
        const updated = action === "grant" ? rights | 1n : rights & ~1n;
        await client.query("UPDATE users SET rights = $1 WHERE id = $2", [updated.toString(), id]);
        await client.query("COMMIT");
        return updated !== rights;
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    let client;
    try {
        const [action, id, ...extra] = process.argv.slice(2);
        if (extra.length || !["grant", "revoke"].includes(action) || !/^[1-9][0-9]{0,19}$/.test(id || ""))
            throw new Error("Usage: bun scripts/ops/operator.mjs <grant|revoke> <account-id>");
        if (!process.env.DATABASE) throw new Error("DATABASE must identify the instance database; run this command from its configured working directory");
        if (process.env.DATABASE.startsWith("sqlite:")) {
            const { Database } = await import("bun:sqlite");
            const { sqlitePath } = await import("../../dist/database/Sql.js");
            const database = new Database(sqlitePath(process.env.DATABASE), { readonly: false, create: false, safeIntegers: true });
            database.exec("PRAGMA busy_timeout = 10000");
            client = {
                connect: async () => {},
                query: async (sql, parameters = []) => {
                    const statement = database.prepare(sql === "BEGIN" ? "BEGIN IMMEDIATE" : sql.replace(" FOR UPDATE", ""));
                    return { rows: statement.columnNames.length ? statement.all(...parameters) : (statement.run(...parameters), []) };
                },
                end: async () => database.close(),
            };
        } else client = new Client({ connectionString: process.env.DATABASE, connectionTimeoutMillis: 10000, statement_timeout: 10000 });
        await client.connect();
        const changed = await setOperator(client, action, id);
        console.log(
            `Account ${id}: operator right ${action === "grant" ? "granted" : "revoked"}${changed ? "" : " (already set)"}. Sign in again to refresh this account's session.`,
        );
    } catch (error) {
        console.error(error instanceof Error && !error.code ? error.message : "Operator update failed; check the database connection and schema");
        process.exitCode = 1;
    } finally {
        await client?.end();
    }
}
