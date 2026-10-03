import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startHarness, type Harness } from '../helpers/harness';

const SAMPLE_CSV = path.join(__dirname, '../../../data/customers-1000.csv');

const POSTGRES_TYPES: Record<string, string> = {
  INTEGER: 'integer',
  BIGINT: 'bigint',
  NUMERIC: 'numeric',
  TIMESTAMP: 'timestamp without time zone',
  TEXT: 'text',
};

describe('POST /upload-csv', () => {
  let h: Harness;

  before(async () => { h = await startHarness(); });
  after(() => h.stop());
  beforeEach(() => h.reset());

  const tables = async () => (await h.sql("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map(r => r.tablename);
  const registered = async () => (await h.sql('SELECT table_name FROM table_schema ORDER BY 1')).map(r => r.table_name);
  const count = async (table: string) => (await h.sql(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
  const columnsOf = async (table: string) =>
    (await h.sql('SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [table])).map(r => r.column_name);
  const dbTypesOf = async (table: string) =>
    Object.fromEntries((await h.sql(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position', [table]
    )).map(r => [r.column_name, r.data_type]));

  describe('the sample dataset (data/customers-1000.csv)', () => {
    it('is imported with the expected columns, types and rows', async () => {
      const { status, body } = await h.upload('customers', readFileSync(SAMPLE_CSV));

      assert.equal(status, 200);
      assert.equal(body.tableName, 'customers');
      assert.equal(body.columnCount, 12);
      assert.deepEqual(body.columnTypes, {
        index: 'INTEGER', customer_id: 'TEXT', first_name: 'TEXT', last_name: 'TEXT', company: 'TEXT', city: 'TEXT',
        country: 'TEXT', phone_1: 'TEXT', phone_2: 'TEXT', email: 'TEXT',
        subscription_date: 'TIMESTAMP', // an ISO date without a time of day
        website: 'TEXT',
      });
      assert.equal(await count('customers'), 1000);
      assert.deepEqual(
        await h.sql("SELECT customer_id, first_name, subscription_date::text AS subscribed FROM customers WHERE index = 1"),
        [{ customer_id: 'dE014d010c7ab0c', first_name: 'Andrew', subscribed: '2021-07-26 00:00:00' }]
      );
    });

    it('is described, and the description is stored for later questions', async () => {
      const { body } = await h.upload('customers', readFileSync(SAMPLE_CSV));

      assert.deepEqual(Object.keys(body.analysis), Object.keys(body.columnTypes));
      const [stored] = await h.sql("SELECT analysis FROM table_schema WHERE table_name = 'customers'");
      assert.deepEqual(stored.analysis, body.analysis);
    });
  });

  describe('table name', () => {
    // An existing table the application did not create: it must survive every payload below.
    beforeEach(async () => {
      await h.sql('CREATE TABLE victim (id int)');
      await h.sql('INSERT INTO victim VALUES (1), (2)');
    });

    async function assertNothingChanged() {
      assert.equal(await count('victim'), 2);
      assert.deepEqual(await tables(), ['table_schema', 'victim']);
      assert.deepEqual(await registered(), []);
    }

    const rejected: Array<[label: string, tableName: string]> = [
      ['a statement appended after a semicolon', 'zz; DROP TABLE victim; --'],
      ['a quote that closes the identifier', 'victim"; DROP TABLE victim; --'],
      ['a column definition', 'x" (id int); DROP TABLE victim; --'],
      ['a single quote', "x'; DROP TABLE victim; --"],
      ['a space', 'a b'],
      ['a dash', 'a-b'],
      ['a schema prefix', 'public.victim'],
      ['a leading digit', '1abc'],
      ['more than 63 characters', 'a'.repeat(64)],
    ];
    for (const [label, tableName] of rejected) {
      it(`rejects ${label}`, async () => {
        const { status, body } = await h.upload(tableName, 'a\n1\n');

        assert.equal(status, 400);
        assert.match(body.error, /Invalid table name/);
        await assertNothingChanged();
      });
    }

    it('rejects a missing or empty name', async () => {
      for (const tableName of [undefined, '', '   ']) {
        const { status, body } = await h.upload(tableName, 'a\n1\n');
        assert.equal(status, 400);
        assert.match(body.error, /Table name is required/);
      }
      await assertNothingChanged();
    });

    it('rejects the internal table_schema and pg_* names, and leaves table_schema as it was', async () => {
      for (const tableName of ['table_schema', 'TABLE_SCHEMA', 'pg_catalog', 'pg_anything']) {
        const { status, body } = await h.upload(tableName, 'a\n1\n');
        assert.equal(status, 400, tableName);
        assert.match(body.error, /reserved/);
      }
      assert.deepEqual(await columnsOf('table_schema'), ['table_name', 'analysis', 'created_at', 'updated_at']);
      await assertNothingChanged();
    });

    it('stores a name in lowercase, so the SQL written by the AI can use it unquoted', async () => {
      const { status, body } = await h.upload('Customers2', 'a\n1\n');

      assert.equal(status, 200);
      assert.equal(body.tableName, 'customers2');
      assert.deepEqual(await registered(), ['customers2']);
      assert.equal(await count('customers2'), 1);
    });

    it('ignores surrounding whitespace', async () => {
      const { status, body } = await h.upload('  padded  ', 'a\n1\n');
      assert.equal(status, 200);
      assert.equal(body.tableName, 'padded');
    });

    it('requires a file', async () => {
      const { status, body } = await h.upload('customers', null);
      assert.equal(status, 400);
      assert.match(body.error, /No file uploaded/);
      await assertNothingChanged();
    });
  });

  describe('existing tables', () => {
    it('never overwrites a table this application did not create', async () => {
      await h.sql('CREATE TABLE victim (id int)');
      await h.sql('INSERT INTO victim VALUES (1), (2)');

      // "VICTIM" is normalized to the same table
      for (const tableName of ['victim', 'VICTIM']) {
        const { status, body } = await h.upload(tableName, 'x,y\n1,2\n');
        assert.equal(status, 409);
        assert.match(body.error, /not created by this application/);
      }

      assert.deepEqual(await columnsOf('victim'), ['id']);
      assert.equal(await count('victim'), 2);
      assert.deepEqual(await registered(), []);
    });

    it('never replaces a view', async () => {
      await h.sql('CREATE VIEW some_view AS SELECT 1 AS x');

      const { status } = await h.upload('some_view', 'a\n1\n');

      assert.equal(status, 409);
      assert.deepEqual(await h.sql('SELECT x FROM some_view'), [{ x: 1 }]);
    });

    it('replaces a table it created itself when the same name is uploaded again', async () => {
      assert.equal((await h.upload('mine', 'a\n1\n')).status, 200);
      const again = await h.upload('mine', 'x,y\n1,2\n3,4\n');

      assert.equal(again.status, 200);
      assert.deepEqual(await columnsOf('mine'), ['x', 'y']);
      assert.equal(await count('mine'), 2);
      assert.deepEqual(await registered(), ['mine']);
    });
  });

  describe('a failed import leaves the existing table untouched', () => {
    beforeEach(async () => {
      assert.equal((await h.upload('keep', 'n\n1\n2\n3\n')).status, 200);
    });

    async function assertKeepIsIntact() {
      assert.deepEqual(await columnsOf('keep'), ['n']);
      assert.equal(await count('keep'), 3);
      const [row] = await h.sql("SELECT analysis IS NOT NULL AS analyzed FROM table_schema WHERE table_name = 'keep'");
      assert.equal(row.analyzed, true);
    }

    it('invalid CSV: a row with the wrong number of fields', async () => {
      const { status, body } = await h.upload('keep', 'a,b\n1,2\n3,4,5,6\n');

      assert.equal(status, 400);
      assert.match(body.error, /Invalid CSV file/);
      await assertKeepIsIntact();
    });

    it('a file with a header and no row', async () => {
      const { status, body } = await h.upload('keep', 'a,b\n');

      assert.equal(status, 400);
      assert.match(body.error, /CSV file is empty/);
      await assertKeepIsIntact();
    });

    it('an empty file', async () => {
      const { status, body } = await h.upload('keep', '');

      assert.equal(status, 400);
      assert.match(body.error, /CSV file is empty/);
      await assertKeepIsIntact();
    });

    it('a failure while the rows are being loaded (the table was already dropped and re-created)', async () => {
      // PostgreSQL text cannot contain a NUL byte: this fails on insert, after the new table exists.
      const { status } = await h.upload('keep', 'a,b\n1,ok\n2,bad\u0000value\n');

      assert.equal(status, 500);
      await assertKeepIsIntact();
    });
  });

  describe('column types', () => {
    /** 1250 rows: enough for three INSERT batches. */
    function typesCsv(rows: number): string {
      let csv = '﻿n,big,price,mixed_num,d,dt,bad_date,zip,txt,empty_col,"Weird Name!",user,"1st"\n'; // starts with a BOM
      for (let i = 1; i <= rows; i++) {
        const blank = i % 10 === 0;
        csv += [
          i,                                           // n: INTEGER
          1234567890 + i,                              // big: does not fit in an INTEGER
          (i / 4).toFixed(2),                          // price: decimals
          i % 2 ? '1' : '2.5',                         // mixed_num: integers and decimals
          '2021-07-26',                                // d: date only
          '2021-07-26 10:30:00',                       // dt: date and time
          i === 7 ? '2021-02-31' : '2021-03-01',       // bad_date: one date that does not exist
          '0' + (1000 + i),                            // zip: leading zero
          blank ? '' : `"a, ""quoted"" ${i}"`,         // txt: commas and quotes, some empty
          '',                                          // empty_col: nothing at all
          blank ? '' : i,                              // Weird Name!: integers with gaps
          'u',                                         // user: an SQL keyword
          'x',                                         // 1st: starts with a digit
        ].join(',') + '\n';
      }
      return csv;
    }

    it('are inferred from every row, and match what PostgreSQL stores', async () => {
      const { status, body } = await h.upload('types_test', typesCsv(1250));

      assert.equal(status, 200);
      const expected = {
        n: 'INTEGER', big: 'BIGINT', price: 'NUMERIC', mixed_num: 'NUMERIC', d: 'TIMESTAMP', dt: 'TIMESTAMP',
        bad_date: 'TEXT', zip: 'TEXT', txt: 'TEXT', empty_col: 'TEXT', weird_name: 'INTEGER', user1: 'TEXT', col_1st: 'TEXT',
      };
      assert.deepEqual(body.columnTypes, expected);
      assert.deepEqual(
        await dbTypesOf('types_test'),
        Object.fromEntries(Object.entries(expected).map(([column, type]) => [column, POSTGRES_TYPES[type]]))
      );
    });

    it('load every row, whatever the number of INSERT batches', async () => {
      await h.upload('types_test', typesCsv(1250));

      assert.equal(await count('types_test'), 1250);
      assert.deepEqual(
        await h.sql('SELECT min(n)::int AS first, max(n)::int AS last, sum(n)::int AS total FROM types_test'),
        [{ first: 1, last: 1250, total: (1250 * 1251) / 2 }]
      );
    });

    it('keep the content of the values', async () => {
      await h.upload('types_test', typesCsv(20));

      const [row] = await h.sql('SELECT * FROM types_test WHERE n = 1');
      assert.equal(row.zip, '01001', 'leading zero');
      assert.equal(row.txt, 'a, "quoted" 1', 'commas and quotes');
      assert.equal(row.dt.toISOString(), '2021-07-26T10:30:00.000Z');
      assert.equal(row.user1, 'u');
      assert.equal(row.col_1st, 'x');
      assert.equal(row.empty_col, null);
      assert.deepEqual(
        await h.sql("SELECT bad_date FROM types_test WHERE n = 7"),
        [{ bad_date: '2021-02-31' }],
        'a value PostgreSQL cannot read as a date stays as text'
      );
    });

    it('store empty fields as NULL, not as empty strings', async () => {
      await h.upload('types_test', typesCsv(20));

      assert.deepEqual(
        await h.sql('SELECT count(*) FILTER (WHERE txt IS NULL)::int AS txt, count(*) FILTER (WHERE weird_name IS NULL)::int AS weird FROM types_test'),
        [{ txt: 2, weird: 2 }]
      );
      assert.deepEqual(await h.sql("SELECT count(*)::int AS n FROM types_test WHERE txt = ''"), [{ n: 0 }]);
    });

    it('do not depend on the first rows: a late value that does not fit changes the column', async () => {
      const { status, body } = await h.upload('late', 'id,score,big\n1,10,1\n2,20,2\n3,abc,5000000000\n');

      assert.equal(status, 200);
      assert.deepEqual(body.columnTypes, { id: 'INTEGER', score: 'TEXT', big: 'BIGINT' });
      assert.deepEqual(await h.sql('SELECT score, big::text FROM late ORDER BY id'), [
        { score: '10', big: '1' }, { score: '20', big: '2' }, { score: 'abc', big: '5000000000' },
      ]);
    });

    it('survive an awkward header: duplicates, empty names, digits first, SQL keywords', async () => {
      const { status, body } = await h.upload('headers', 'id,Name,name,,1st,order\n1,a,b,c,d,e\n');

      assert.equal(status, 200);
      assert.deepEqual(Object.keys(body.columnTypes), ['id', 'name', 'name_2', 'column_4', 'col_1st', 'order1']);
      assert.deepEqual(await h.sql('SELECT name, name_2, column_4, col_1st, order1 FROM headers'), [
        { name: 'a', name_2: 'b', column_4: 'c', col_1st: 'd', order1: 'e' },
      ]);
    });

    it('accept Windows line endings', async () => {
      const { status, body } = await h.upload('crlf', 'a,b\r\n1,x\r\n2,y\r\n');

      assert.equal(status, 200);
      assert.deepEqual(body.columnTypes, { a: 'INTEGER', b: 'TEXT' });
      assert.deepEqual(await h.sql('SELECT b FROM crlf ORDER BY a'), [{ b: 'x' }, { b: 'y' }]);
    });
  });

  describe('analysis', () => {
    it('computes the share of NULLs on the rows that exist, not on a fixed sample size', async () => {
      await h.upload('small', 'a,b\n1,x\n2,\n3,z\n'); // one NULL in three rows

      const [summary] = h.ai.callsTo('tableSummary');
      assert.equal(summary.dictionary!.a.nullCount, 0);
      assert.equal(summary.dictionary!.a.nullPercentage, 0);
      assert.equal(summary.dictionary!.b.nullCount, 1);
      assert.ok(Math.abs(summary.dictionary!.b.nullPercentage - 100 / 3) < 0.001, `got ${summary.dictionary!.b.nullPercentage}`);
    });

    it('reports a failure of the AI, keeps the table, and lets the upload be retried', async () => {
      h.ai.handlers.tableSummary = () => 'this is not JSON';
      const failed = await h.upload('flaky', 'a,b\n1,2\n');

      assert.equal(failed.status, 500);
      assert.deepEqual(await tables(), ['flaky', 'table_schema']);
      assert.deepEqual(
        await h.sql("SELECT table_name, analysis IS NULL AS pending FROM table_schema"),
        [{ table_name: 'flaky', pending: true }]
      );

      delete h.ai.handlers.tableSummary;
      const retried = await h.upload('flaky', 'a,b\n1,2\n');

      assert.equal(retried.status, 200, 'the table must not block its own retry');
      assert.deepEqual(
        await h.sql("SELECT analysis IS NOT NULL AS analyzed FROM table_schema WHERE table_name = 'flaky'"),
        [{ analyzed: true }]
      );
    });
  });
});
