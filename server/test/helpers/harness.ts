import { chmod, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { startEmbeddedPostgres, EmbeddedDatabaseError, type EmbeddedDatabase } from '../../src/embedded-postgres';
import { quoteIdent } from '../../src/sql-safety';
import { FakeOpenAI } from './fake-openai';

// Starts the real application (routes, SQL, pipeline) on a random port, with:
//  - its own PostgreSQL server (the embedded one the application uses), on a free port and in a
//    temporary folder, started for this test file and deleted at the end;
//  - a FakeOpenAI server standing in for OpenRouter.
// Nothing has to be installed or running beforehand, and nothing of the developer's own database or
// server/.env is used.
//
// The application reads its configuration when its modules are first imported, so a test file can
// start one harness only.

export interface HarnessOptions {
  /** Create a role with SELECT-only privileges and use it for the SQL written by the AI. */
  readOnlyRole?: boolean;
  /** Extra environment for the application (LLM_MODEL, LLM_JSON_MODE...). */
  env?: Record<string, string>;
}

export interface Harness {
  baseUrl: string;
  dbName: string;
  ai: FakeOpenAI;
  /** Set when started with { readOnlyRole: true }: the role used for AI-generated SQL. */
  readOnlyRole?: string;
  /** Runs SQL in the test database as its owner, the application's own user. */
  sql(text: string, params?: unknown[]): Promise<any[]>;
  /** POST /upload-csv. A null csv sends no file; an undefined tableName sends no table name. */
  upload(tableName: string | undefined, csv: string | Buffer | null, filename?: string): Promise<HttpResult>;
  /** POST /query with { message }. An undefined message sends an empty body. */
  ask(message: unknown): Promise<HttpResult>;
  /** Empties the database (all tables but table_schema, which is truncated) and the fake AI. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export interface HttpResult {
  status: number;
  body: any;
}

/** A port nobody listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** A temporary folder PostgreSQL can use even when the tests run as root (it then runs as "postgres"). */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await chmod(dir, 0o755);
  return dir;
}

export const TEST_DB_USER = 'postgres';
export const TEST_DB_PASSWORD = 'test-password';

export async function startHarness({ readOnlyRole = false, env = {} }: HarnessOptions = {}): Promise<Harness> {
  const cleanups: Array<() => Promise<void> | void> = [];
  const stop = async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    cleanups.length = 0;
    if (errors.length) throw errors[0];
  };

  try {
    // The application logs every step of its pipeline: keep test output readable.
    if (!process.env.TEST_VERBOSE) {
      const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
      Object.assign(console, { log() {}, info() {}, warn() {}, error() {} });
      cleanups.push(() => void Object.assign(console, saved));
    }

    const ai = await FakeOpenAI.start();
    cleanups.push(() => ai.close());

    const dbName = 'sqlgen_test';
    const dataRoot = await tempDir('sqlgen-test-pg-');
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));

    // Another test file may pick the same free port between our check and the server's start: try again.
    let port = 0;
    let database: EmbeddedDatabase | undefined;
    for (let attempt = 1; !database; attempt++) {
      port = await freePort();
      try {
        database = await startEmbeddedPostgres({
          dataDir: path.join(dataRoot, 'pg'), port, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: dbName,
        });
      } catch (error) {
        const portTaken = error instanceof EmbeddedDatabaseError && /already (used|listening)/.test(error.message);
        if (!portTaken || attempt >= 3) throw error;
      }
    }
    cleanups.push(() => database!.stop());

    const db = new Client({ host: '127.0.0.1', port, user: TEST_DB_USER, password: TEST_DB_PASSWORD, database: dbName });
    await db.connect();
    cleanups.push(() => db.end());
    const sql = async (text: string, params?: unknown[]) => (await db.query(text, params)).rows;

    let role: string | undefined;
    if (readOnlyRole) {
      role = 'sqlgen_ro';
      await db.query(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD 'test-password'`);
      // The statements documented in the README ("Security notes"), with the test names.
      await db.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(role)}`);
      await db.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(role)}`);
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdent(role)}`);
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdent(role)}`);
    }

    // Everything the application reads is set here, empty values included: dotenv, which the
    // application loads, never overrides a variable that already exists, so a developer's own
    // server/.env cannot leak into the tests.
    Object.assign(process.env, {
      PORT: '', DB_DATA_DIR: '', DB_EMBEDDED: 'false',
      DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_NAME: dbName, DB_USER: TEST_DB_USER, DB_PASSWORD: TEST_DB_PASSWORD,
      DB_READONLY_USER: role ?? '', DB_READONLY_PASSWORD: role ? 'test-password' : '',
      OPENROUTER_API_KEY: 'test-key', LLM_BASE_URL: ai.url, LLM_MODEL: '', LLM_JSON_MODE: '',
      ...env,
    });
    const { createApp } = await import('../../src/app');
    const { initializeTables, closeDb } = await import('../../src/db');
    await initializeTables();
    cleanups.push(() => closeDb());

    const uploadDir = await tempDir('sqlgen-test-uploads-');
    cleanups.push(() => rm(uploadDir, { recursive: true, force: true }));
    const server: Server = createApp({ uploadDir }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    cleanups.push(() => {
      server.closeAllConnections();
      return new Promise<void>(resolve => server.close(() => resolve()));
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const send = async (url: string, init: RequestInit): Promise<HttpResult> => {
      const response = await fetch(`${baseUrl}${url}`, init);
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    return {
      baseUrl,
      dbName,
      ai,
      readOnlyRole: role,
      sql,
      upload(tableName, csv, filename = 'data.csv') {
        const form = new FormData();
        if (csv !== null) form.append('file', new Blob([csv], { type: 'text/csv' }), filename);
        if (tableName !== undefined) form.append('tableName', tableName);
        return send('/upload-csv', { method: 'POST', body: form });
      },
      ask(message) {
        return send('/query', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message === undefined ? {} : { message }),
        });
      },
      async reset() {
        await db.query(`
          DO $$
          DECLARE r record;
          BEGIN
            FOR r IN SELECT viewname AS name FROM pg_views WHERE schemaname = 'public' LOOP
              EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', r.name);
            END LOOP;
            FOR r IN SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'table_schema' LOOP
              EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.name);
            END LOOP;
            FOR r IN SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public' LOOP
              EXECUTE format('DROP SEQUENCE IF EXISTS %I CASCADE', r.name);
            END LOOP;
          END $$`);
        await db.query('TRUNCATE table_schema');
        ai.reset();
      },
      stop,
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}
