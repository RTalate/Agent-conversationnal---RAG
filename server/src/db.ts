import pg from "pg";
import type { PoolClient, QueryConfig } from "pg";
import { assertSelectQuery } from "./sql-safety";
const { Pool } = pg;

const connection = {
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  port: parseInt(process.env.DB_PORT || "5432"),
};

const pool = new Pool({
  ...connection,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// SQL written by the LLM can run as a dedicated role that only has SELECT (see README).
// Without it, it runs as DB_USER, inside a READ ONLY transaction.
const readOnlyPool = process.env.DB_READONLY_USER
  ? new Pool({
      ...connection,
      user: process.env.DB_READONLY_USER,
      password: process.env.DB_READONLY_PASSWORD,
    })
  : pool;

if (readOnlyPool === pool) {
  console.warn(
    "DB_READONLY_USER is not set: AI-generated SQL runs as DB_USER (in a READ ONLY transaction). " +
      "Set DB_READONLY_USER to a role with SELECT-only privileges for defense in depth."
  );
}

const READ_ONLY_STATEMENT_TIMEOUT_MS = 10_000;

// Waits for in-flight queries, then closes every connection.
export const closeDb = async () => {
  await Promise.all([pool.end(), readOnlyPool !== pool ? readOnlyPool.end() : undefined]);
};

export const initializeTables = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS TABLE_SCHEMA (
      table_name TEXT PRIMARY KEY,
      analysis JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
};

export const query = (text: string, params?: any[]) => pool.query(text, params);

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// Runs a query written by the LLM. Defenses, in order:
//  1. it must start with SELECT or WITH (assertSelectQuery);
//  2. extended query protocol: PostgreSQL rejects anything that is not a single statement,
//     so "SELECT 1; COMMIT; DROP TABLE x" cannot escape the transaction below;
//  3. READ ONLY transaction: the database refuses any write, whatever the SQL says;
//  4. statement timeout (10 seconds by default), so a runaway query cannot hold the connection.
// The transaction is always rolled back.
export async function queryReadOnly(sql: string, timeoutMs: number = READ_ONLY_STATEMENT_TIMEOUT_MS) {
  assertSelectQuery(sql);
  const client = await readOnlyPool.connect();
  let broken = false;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    // queryMode is supported by pg >= 8.13 but missing from the installed @types/pg.
    return await client.query({ text: sql, queryMode: "extended" } as QueryConfig);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}
