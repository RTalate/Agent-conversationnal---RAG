import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { quoteIdent } from '../../src/sql-safety';
import { FakeOpenAI } from './fake-openai';

// Starts the real application (routes, SQL, pipeline) on a random port, with:
//  - a throwaway PostgreSQL database, created for this test file and dropped at the end;
//  - a FakeOpenAI server instead of OpenAI.
// It never touches DB_NAME: the connection settings (DB_USER, DB_PASSWORD, DB_HOST, DB_PORT, and a
// .env file if there is one) are only used to create and drop its own database. The user needs
// the privilege to create databases and roles (a superuser such as `postgres` does).
//
// The application reads its configuration when its modules are first imported, so a test file can
// start one harness only.

export interface Harness {
  baseUrl: string;
  dbName: string;
  ai: FakeOpenAI;
  /** Set when started with { readOnlyRole: true }: the role used for AI-generated SQL. */
  readOnlyRole?: string;
  /** Runs SQL in the throwaway database as DB_USER, the application's own user. */
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

export async function startHarness({ readOnlyRole = false }: { readOnlyRole?: boolean } = {}): Promise<Harness> {
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
    // Settings meant for the developer's own database must not leak into the tests.
    delete process.env.DB_READONLY_USER;
    delete process.env.DB_READONLY_PASSWORD;
    delete process.env.OPENAI_MODEL;

    const ai = await FakeOpenAI.start();
    cleanups.push(() => ai.close());

    const connection = {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };
    const admin = new Client({ ...connection, database: process.env.TEST_ADMIN_DB || 'postgres' });
    try {
      await admin.connect();
    } catch (error: any) {
      throw new Error(
        `Integration tests need a reachable PostgreSQL (${connection.host ?? 'localhost'}:${connection.port}, ` +
        `user ${connection.user ?? '(default)'}) with the privilege to create databases: ${error.message}\n` +
        'Set DB_HOST, DB_PORT, DB_USER and DB_PASSWORD (or server/.env), or run "npm run test:unit".'
      );
    }
    cleanups.push(() => admin.end());

    // Cleanups run in reverse order: the role is dropped last, once the database it has
    // privileges on is gone.
    let role: string | undefined;
    if (readOnlyRole) {
      role = `sqlgen_ro_${randomBytes(3).toString('hex')}`;
      await admin.query(`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD 'test-password'`);
      cleanups.push(async () => { await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role!)}`); });
    }

    const dbName = `sqlgen_test_${process.pid}_${randomBytes(3).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    cleanups.push(async () => { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`); });

    const db = new Client({ ...connection, database: dbName });
    await db.connect();
    cleanups.push(() => db.end());
    const sql = async (text: string, params?: unknown[]) => (await db.query(text, params)).rows;

    if (role) {
      // The statements documented in the README ("Security notes"), with the test names.
      await db.query(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(role)}`);
      await db.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(role)}`);
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quoteIdent(role)}`);
      await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${quoteIdent(role)}`);
      process.env.DB_READONLY_USER = role;
      process.env.DB_READONLY_PASSWORD = 'test-password';
    }

    process.env.DB_NAME = dbName;
    process.env.OPENAI_BASE_URL = ai.url;
    const { createApp } = await import('../../src/app');
    const { initializeTables, closeDb } = await import('../../src/db');
    await initializeTables();
    cleanups.push(() => closeDb());

    const uploadDir = await mkdtemp(path.join(tmpdir(), 'sqlgen-test-uploads-'));
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
