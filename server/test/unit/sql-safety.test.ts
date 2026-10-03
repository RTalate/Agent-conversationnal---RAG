import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSelectQuery, InvalidInputError, parseTableName, quoteIdent } from '../../src/sql-safety';

describe('parseTableName', () => {
  const accepted: Array<[input: string, expected: string]> = [
    ['customers', 'customers'],
    [' My_Table ', 'my_table'],
    ['CUSTOMERS2', 'customers2'],
    ['_x1', '_x1'],
    ['a'.repeat(63), 'a'.repeat(63)],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input.length > 20 ? input.slice(0, 8) + '…' : input)} as "${expected.slice(0, 12)}"`, () => {
      assert.equal(parseTableName(input), expected);
    });
  }

  const rejected: unknown[] = [
    '', '   ',
    'a b', 'a-b', 'a.b', 'public.customers', '1abc', 'é', 'a\nb',
    '"customers"', 'a;b', "x'; drop table y; --", 'zz; DROP TABLE customers; --',
    'a'.repeat(64),
    'table_schema', 'TABLE_SCHEMA', 'pg_catalog', 'PG_temp',
    ['customers'], { toString: () => 'customers' }, 42, null, undefined,
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input) ?? String(input)}`, () => {
      assert.throws(() => parseTableName(input), InvalidInputError);
    });
  }
});

describe('quoteIdent', () => {
  it('wraps the identifier in double quotes', () => {
    assert.equal(quoteIdent('customers'), '"customers"');
  });

  it('doubles embedded quotes so the identifier cannot be closed early', () => {
    assert.equal(quoteIdent('a"b'), '"a""b"');
    assert.equal(quoteIdent('x"; DROP TABLE y; --'), '"x""; DROP TABLE y; --"');
  });
});

describe('assertSelectQuery', () => {
  const allowed = [
    'SELECT 1',
    'select 1',
    '  \n\t select 1',
    'SELECT 1;',
    '-- a comment\nSELECT 1',
    '/* a comment */ SELECT 1',
    '/* a */ -- b\n  WITH x AS (SELECT 1) SELECT * FROM x',
    'with c as (select 1 as a) select * from c',
  ];
  for (const sql of allowed) {
    it(`accepts ${JSON.stringify(sql)} and returns it unchanged`, () => {
      assert.equal(assertSelectQuery(sql), sql);
    });
  }

  const forbidden = [
    'DROP TABLE customers',
    'DELETE FROM customers',
    'UPDATE customers SET country = NULL',
    "INSERT INTO customers (city) VALUES ('x')",
    'TRUNCATE customers',
    'ALTER TABLE customers ADD COLUMN x int',
    'CREATE TABLE copy AS SELECT * FROM customers',
    "COPY (SELECT 1) TO PROGRAM 'touch /tmp/x'",
    'DO $$ BEGIN DELETE FROM customers; END $$',
    'CALL do_something()',
    'SET TRANSACTION READ WRITE',
    'EXPLAIN ANALYZE DELETE FROM customers',
    'selection 1', // starts with "select" but is not the keyword
    '-- comment\nDROP TABLE customers',
    '/* comment */ delete from customers',
    '-- only a comment',
    '/* unterminated SELECT 1',
  ];
  for (const sql of forbidden) {
    it(`rejects ${JSON.stringify(sql)}`, () => {
      assert.throws(() => assertSelectQuery(sql), /Only SELECT queries are allowed/);
    });
  }

  for (const sql of ['', '   ', null, undefined, 42, {}]) {
    it(`rejects an empty or non-string query: ${JSON.stringify(sql) ?? String(sql)}`, () => {
      assert.throws(() => assertSelectQuery(sql), /empty/);
    });
  }
});
