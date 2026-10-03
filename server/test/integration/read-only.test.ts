import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHarness, type Harness } from '../helpers/harness';

// queryReadOnly() runs the SQL written by the AI. Whatever that SQL says, it must not be able to
// change anything. Errors are matched on their SQLSTATE code, not on their text, which depends on
// the language of the PostgreSQL server.

type Rejection = (error: any) => boolean;
const refusedBeforeExecution: Rejection = error => /Only SELECT queries are allowed/.test(error.message);
const sqlstate = (code: string): Rejection => error => error.code === code;
const SYNTAX_ERROR = '42601'; // several statements in one prepared statement
const READ_ONLY_TRANSACTION = '25006';
const INVALID_TRANSACTION_STATE = '25'; // class of "read-write mode must be set before any query"

describe('queryReadOnly', () => {
  let h: Harness;
  let queryReadOnly: (sql: string, timeoutMs?: number) => Promise<{ rows: any[] }>;

  before(async () => {
    h = await startHarness();
    ({ queryReadOnly } = await import('../../src/db'));
  });
  after(() => h.stop());

  beforeEach(async () => {
    await h.reset();
    await h.sql('CREATE SEQUENCE s_guard');
    await h.sql('CREATE TABLE t_guard (id int)');
    await h.sql('INSERT INTO t_guard VALUES (1), (2), (3)');
  });

  async function assertNothingChanged() {
    assert.deepEqual(await h.sql('SELECT id FROM t_guard ORDER BY id'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.deepEqual(await h.sql("SELECT to_regclass('t_new') IS NULL AS absent"), [{ absent: true }]);
    assert.deepEqual(await h.sql('SELECT last_value::int AS value, is_called FROM s_guard'), [{ value: 1, is_called: false }]);
  }

  describe('refuses anything that could change the database', () => {
    const attacks: Array<[label: string, sql: string, rejection: Rejection]> = [
      ['DROP TABLE', 'DROP TABLE t_guard', refusedBeforeExecution],
      ['DELETE', 'DELETE FROM t_guard', refusedBeforeExecution],
      ['UPDATE', 'UPDATE t_guard SET id = 0', refusedBeforeExecution],
      ['INSERT', 'INSERT INTO t_guard VALUES (9)', refusedBeforeExecution],
      ['TRUNCATE', 'TRUNCATE t_guard', refusedBeforeExecution],
      ['CREATE TABLE AS', 'CREATE TABLE t_new AS SELECT * FROM t_guard', refusedBeforeExecution],
      ['a DO block', 'DO $$ BEGIN DELETE FROM t_guard; END $$', refusedBeforeExecution],
      ['SET TRANSACTION READ WRITE', 'SET TRANSACTION READ WRITE', refusedBeforeExecution],
      ['a comment hiding the statement', '-- harmless\nDROP TABLE t_guard', refusedBeforeExecution],
      ['a block comment hiding the statement', '/* harmless */ DELETE FROM t_guard', refusedBeforeExecution],

      // These start with SELECT or WITH: the database itself has to stop them.
      ['stacked statements', 'SELECT 1; DROP TABLE t_guard', sqlstate(SYNTAX_ERROR)],
      ['stacked statements that end the transaction first', 'SELECT 1; COMMIT; DROP TABLE t_guard', sqlstate(SYNTAX_ERROR)],
      ['stacked statements that start a new transaction', 'SELECT 1; ROLLBACK; BEGIN; DROP TABLE t_guard; COMMIT', sqlstate(SYNTAX_ERROR)],
      ['DELETE inside a CTE', 'WITH d AS (DELETE FROM t_guard RETURNING *) SELECT count(*) FROM d', sqlstate(READ_ONLY_TRANSACTION)],
      ['INSERT inside a CTE', 'WITH i AS (INSERT INTO t_guard VALUES (7) RETURNING *) SELECT * FROM i', sqlstate(READ_ONLY_TRANSACTION)],
      ['SELECT INTO, which creates a table', 'SELECT * INTO t_new FROM t_guard', sqlstate(READ_ONLY_TRANSACTION)],
      ['advancing a sequence', "SELECT nextval('s_guard')", sqlstate(READ_ONLY_TRANSACTION)],
      ['setting a sequence', "SELECT setval('s_guard', 500)", sqlstate(READ_ONLY_TRANSACTION)],
      ['switching the transaction to read-write', "SELECT set_config('transaction_read_only', 'off', true)", error => error.code?.startsWith(INVALID_TRANSACTION_STATE)],
    ];

    for (const [label, sql, rejection] of attacks) {
      it(label, async () => {
        await assert.rejects(() => queryReadOnly(sql), (error: any) => {
          assert.ok(rejection(error), `unexpected error (${error.code ?? 'no code'}): ${error.message}`);
          return true;
        });
        await assertNothingChanged();
      });
    }

    it('COPY ... TO PROGRAM, which would run a command on the database server', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'sqlgen-copy-'));
      const marker = path.join(dir, 'executed');
      try {
        await assert.rejects(() => queryReadOnly(`COPY (SELECT 1) TO PROGRAM 'touch ${marker}'`), refusedBeforeExecution);
        assert.equal(existsSync(marker), false, 'the command ran');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('an empty query', async () => {
      await assert.rejects(() => queryReadOnly(''), /empty/);
      await assert.rejects(() => queryReadOnly('   '), /empty/);
    });
  });

  describe('keeps the connection safe for the next query', () => {
    it('a query cannot change the connection to read-write for later ones', async () => {
      // Session-level setting, attempted from a query that is itself allowed to run.
      await queryReadOnly("SELECT set_config('default_transaction_read_only', 'off', false)").catch(() => {});
      await assert.rejects(
        () => queryReadOnly('WITH d AS (DELETE FROM t_guard RETURNING *) SELECT count(*) FROM d'),
        sqlstate(READ_ONLY_TRANSACTION)
      );
      await assertNothingChanged();
    });

    it('every refused query releases its connection (50 failures, then a success)', async () => {
      for (let i = 0; i < 50; i++) {
        await queryReadOnly(i % 2 ? 'SELECT 1; SELECT 2' : 'SELECT * FROM table_that_does_not_exist').catch(() => {});
      }
      const outcome = await Promise.race([
        queryReadOnly('SELECT 1 AS ok'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the pool is exhausted')), 5000)),
      ]);
      assert.deepEqual(outcome.rows, [{ ok: 1 }]);
    });

    it('handles concurrent queries', async () => {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => queryReadOnly(`SELECT pg_sleep(0.02), ${i} AS i`))
      );
      assert.deepEqual(results.map(result => result.rows[0].i), Array.from({ length: 30 }, (_, i) => i));
    });
  });

  describe('statement timeout', () => {
    it('cancels a query that runs too long, and the connection still works afterwards', async () => {
      const started = Date.now();
      await assert.rejects(() => queryReadOnly('SELECT pg_sleep(30)', 300), sqlstate('57014'));
      assert.ok(Date.now() - started < 5000, 'the query was not cancelled in time');
      assert.deepEqual((await queryReadOnly('SELECT 1 AS ok')).rows, [{ ok: 1 }]);
    });
  });

  describe('still runs legitimate queries', () => {
    const queries: Array<[label: string, sql: string]> = [
      ['a plain SELECT', 'SELECT count(*)::int AS n FROM t_guard'],
      ['a trailing semicolon', 'SELECT id FROM t_guard ORDER BY id;'],
      ['lowercase, with surrounding whitespace', '\n  select id from t_guard\n'],
      ['a leading line comment', '-- count them\nSELECT count(*) FROM t_guard'],
      ['a leading block comment', '/* count them */ SELECT count(*) FROM t_guard'],
      ['a read-only CTE', 'WITH c AS (SELECT id FROM t_guard) SELECT sum(id) AS total FROM c'],
      ['a window function', 'SELECT id, row_number() OVER (ORDER BY id) FROM t_guard'],
      ['a catalog query', "SELECT table_name FROM information_schema.tables WHERE table_name = 't_guard'"],
    ];
    for (const [label, sql] of queries) {
      it(label, async () => {
        await queryReadOnly(sql);
      });
    }

    it('returns the rows', async () => {
      const result = await queryReadOnly('SELECT id FROM t_guard ORDER BY id');
      assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    });
  });
});
