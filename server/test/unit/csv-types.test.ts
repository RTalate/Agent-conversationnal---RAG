import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildColumnNames, classifyValue, mergeTypes, type ColumnType } from '../../src/csv-import';

describe('classifyValue', () => {
  const cases: Array<[type: ColumnType, values: string[]]> = [
    ['INTEGER', ['0', '7', '-12', '123456789']],
    ['BIGINT', ['1234567890', '-1234567890', '999999999999999999']],
    ['NUMERIC', ['1.5', '-0.25', '.5', '10.00']],
    ['TIMESTAMP', [
      '2021-07-26', // date only: must not be mistaken for text (it once was)
      '2020-02-29',
      '2021-07-26 10:30',
      '2021-07-26 10:30:00',
      '2021-07-26T10:30:00Z',
      '2021-07-26T10:30:00.123+02:00',
      '2021-07-26T10:30:00-12:00',
      '2021-07-26T10:30:00+15:59',
    ]],
    // identifiers and codes that merely look numeric keep their formatting
    ['TEXT', ['007', '00', '+5', '1e5', ' 12', '1,5', '1234567890123456789']],
    // dates PostgreSQL would reject, or formats whose meaning depends on the server's DateStyle
    ['TEXT', [
      '2021-02-31', '2019-02-29', '2021-13-01', '2021-00-10', '0000-01-01',
      '2021-07-26T25:00:00', '2021-07-26 10:60',
      '2021-07-26T10:30:00+25:00', '2021-07-26T10:30:00+16:00',
      '07/26/2021', '26/07/2021', '2021-7-26',
    ]],
    ['TEXT', ['hello', 'http://www.shea.biz/', '846-790-4623x4715', '(422)787-2331x71127', '321.441.0588x6218']],
  ];
  for (const [type, values] of cases) {
    for (const value of values) {
      it(`${JSON.stringify(value)} is ${type}`, () => {
        assert.equal(classifyValue(value), type);
      });
    }
  }
});

describe('mergeTypes', () => {
  const cases: Array<[current: ColumnType | undefined, next: ColumnType, expected: ColumnType]> = [
    [undefined, 'INTEGER', 'INTEGER'],
    [undefined, 'TEXT', 'TEXT'],
    ['INTEGER', 'INTEGER', 'INTEGER'],
    ['TIMESTAMP', 'TIMESTAMP', 'TIMESTAMP'],
    ['INTEGER', 'BIGINT', 'BIGINT'],
    ['BIGINT', 'INTEGER', 'BIGINT'],
    ['INTEGER', 'NUMERIC', 'NUMERIC'],
    ['NUMERIC', 'INTEGER', 'NUMERIC'],
    ['BIGINT', 'NUMERIC', 'NUMERIC'],
    ['INTEGER', 'TEXT', 'TEXT'],
    ['TEXT', 'INTEGER', 'TEXT'],
    ['TIMESTAMP', 'INTEGER', 'TEXT'],
    ['NUMERIC', 'TIMESTAMP', 'TEXT'],
    ['TIMESTAMP', 'TEXT', 'TEXT'],
  ];
  for (const [current, next, expected] of cases) {
    it(`${current ?? 'nothing'} + ${next} = ${expected}`, () => {
      assert.equal(mergeTypes(current, next), expected);
    });
  }

  const fold = (values: string[]) =>
    values.reduce<ColumnType | undefined>((type, value) => mergeTypes(type, classifyValue(value)), undefined);

  it('widens a column as its values demand: the first value does not decide', () => {
    assert.equal(fold(['1', '2']), 'INTEGER');
    assert.equal(fold(['1', '1234567890']), 'BIGINT');
    assert.equal(fold(['1', '2.5']), 'NUMERIC');
    assert.equal(fold(['1', '2.5', 'abc']), 'TEXT');
    assert.equal(fold(['abc', '1']), 'TEXT');
    assert.equal(fold(['2021-07-26', '2021-07-26 10:30:00']), 'TIMESTAMP');
    assert.equal(fold(['2021-07-26', '2021-02-31']), 'TEXT');
  });
});

describe('buildColumnNames', () => {
  const cases: Array<[label: string, header: string[], expected: string[]]> = [
    ['lowercases and replaces separators', ['First Name', 'Customer Id', 'Phone 1'], ['first_name', 'customer_id', 'phone_1']],
    ['strips punctuation at the edges', ['Weird Name!', '  spaced  ', '__x__'], ['weird_name', 'spaced', 'x']],
    ['replaces accents, which are not valid in unquoted names', ['Prénom'], ['pr_nom']],
    ['renames SQL keywords', ['user', 'Order', 'GROUP'], ['user1', 'order1', 'group1']],
    ['names empty headers by position', ['', '###', '  '], ['column_1', 'column_2', 'column_3']],
    ['prefixes names that start with a digit', ['1st', '2nd place'], ['col_1st', 'col_2nd_place']],
    ['de-duplicates, ignoring case', ['Name', 'name', 'NAME'], ['name', 'name_2', 'name_3']],
    ['de-duplicates against names it generated itself', ['a', 'a', 'a_2'], ['a', 'a_2', 'a_2_2']],
  ];
  for (const [label, header, expected] of cases) {
    it(label, () => {
      assert.deepEqual(buildColumnNames(header), expected);
    });
  }

  it('truncates long names and keeps them unique and within the 63 character limit', () => {
    const long = 'x'.repeat(80);
    const names = buildColumnNames([long, long, long]);
    assert.equal(new Set(names).size, 3);
    for (const name of names) assert.ok(name.length <= 63, `${name} is ${name.length} characters`);
  });

  it('always produces unique, lowercase, valid identifiers, whatever the header', () => {
    const hostile = ['', ' ', '"', "'; DROP TABLE x; --", 'ÀÉÎ', '日本語', '1', '1', 'a b', 'a_b', 'A-B', 'select', 'SELECT', '\n', 'x'.repeat(100)];
    const names = buildColumnNames(hostile);
    assert.equal(names.length, hostile.length);
    assert.equal(new Set(names).size, names.length);
    for (const name of names) assert.match(name, /^[a-z_][a-z0-9_]{0,62}$/);
  });
});
