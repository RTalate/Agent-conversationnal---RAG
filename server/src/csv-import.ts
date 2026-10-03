import { createReadStream } from 'fs';
import { parse } from 'csv-parse';
import { withTransaction } from './db';
import { InvalidInputError, quoteIdent } from './sql-safety';

type ColumnType = 'INTEGER' | 'BIGINT' | 'NUMERIC' | 'TIMESTAMP' | 'TEXT';

const RESERVED_KEYWORDS = ['user', 'group', 'order', 'select', 'where', 'from', 'table', 'column'];
// PostgreSQL truncates identifiers at 63 characters; keep room for a de-duplication suffix.
const MAX_COLUMN_NAME_LENGTH = 60;
const MAX_ROWS_PER_INSERT = 500;
// The PostgreSQL wire protocol allows at most 65535 bind parameters per statement.
const MAX_BIND_PARAMETERS = 60000;

function normalizeColumnName(column: string): string {
  let normalized = column.trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  // If it's a reserved keyword, append '1'
  if (RESERVED_KEYWORDS.includes(normalized)) {
    normalized += '1';
  }

  return normalized;
}

// Turns CSV headers into valid, unique, lowercase column names.
function buildColumnNames(header: string[]): string[] {
  const used = new Set<string>();
  return header.map((raw, index) => {
    let name = normalizeColumnName(raw).slice(0, MAX_COLUMN_NAME_LENGTH);
    if (!name) name = `column_${index + 1}`;
    else if (/^[0-9]/.test(name)) name = `col_${name}`;

    let candidate = name;
    for (let suffix = 2; used.has(candidate); suffix++) {
      candidate = `${name}_${suffix}`;
    }
    used.add(candidate);
    return candidate;
  });
}

const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/; // no leading zeros: "007" is an identifier, not a number
const DECIMAL_PATTERN = /^-?\d*\.\d+$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

// Date.parse() is too lenient ("2021-02-31" rolls over to March); PostgreSQL rejects it.
function isTimestamp(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  // Optional groups (time of day) are undefined for a date-only value: treat them as 0.
  const [year, month, day, hour, minute, second] = match.slice(1).map(group => Number(group ?? 0));
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1 &&
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    hour <= 23 && minute <= 59 && second <= 59;
}

function classifyValue(value: string): ColumnType {
  if (INTEGER_PATTERN.test(value)) {
    const digits = value.replace('-', '').length;
    if (digits <= 9) return 'INTEGER';
    if (digits <= 18) return 'BIGINT';
    return 'TEXT';
  }
  if (DECIMAL_PATTERN.test(value)) return 'NUMERIC';
  if (isTimestamp(value)) return 'TIMESTAMP';
  return 'TEXT';
}

const NUMERIC_RANK: Partial<Record<ColumnType, number>> = { INTEGER: 0, BIGINT: 1, NUMERIC: 2 };

// Smallest type that holds both: numbers widen (INTEGER < BIGINT < NUMERIC), anything else is TEXT.
function mergeTypes(current: ColumnType | undefined, next: ColumnType): ColumnType {
  if (current === undefined || current === next) return next;
  const currentRank = NUMERIC_RANK[current];
  const nextRank = NUMERIC_RANK[next];
  if (currentRank !== undefined && nextRank !== undefined) {
    return currentRank >= nextRank ? current : next;
  }
  return 'TEXT';
}

export interface ImportResult {
  columns: string[];
  columnTypes: Record<string, ColumnType>;
  rowCount: number;
}

// Replaces `tableName` with the content of the CSV file. Everything happens in one
// transaction, so a failed import leaves any existing table untouched.
// `tableName` must already have been checked with parseTableName().
export async function importCsv(filePath: string, tableName: string): Promise<ImportResult> {
  let columns: string[] = [];
  const openParser = () => {
    const parser = parse({
      columns: (header: string[]) => (columns = buildColumnNames(header)),
      skip_empty_lines: true,
      bom: true,
    });
    return createReadStream(filePath).on('error', (error) => parser.destroy(error)).pipe(parser);
  };

  // Pass 1: infer column types from every row, not just the first few.
  const inferred = new Map<string, ColumnType>();
  let rowCount = 0;
  for await (const record of openParser()) {
    rowCount++;
    for (const [column, value] of Object.entries<string>(record)) {
      if (value !== '') inferred.set(column, mergeTypes(inferred.get(column), classifyValue(value)));
    }
  }
  if (rowCount === 0) {
    throw new InvalidInputError('CSV file is empty');
  }
  const columnTypes = Object.fromEntries(
    columns.map(column => [column, inferred.get(column) ?? 'TEXT'])
  ) as Record<string, ColumnType>;

  // Pass 2: create the table and load it.
  const table = quoteIdent(tableName);
  const rowsPerInsert = Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(MAX_BIND_PARAMETERS / columns.length)));

  await withTransaction(async (client) => {
    await client.query(`DROP TABLE IF EXISTS ${table}`);
    await client.query(`
      CREATE TABLE ${table} (
        ${columns.map(column => `${quoteIdent(column)} ${columnTypes[column]}`).join(',\n')}
      )
    `);
    // Registered in the same transaction: the table is only ever replaced if it is listed here.
    // The analysis is filled in once the data is loaded.
    await client.query(
      `INSERT INTO TABLE_SCHEMA (table_name, analysis)
       VALUES ($1, NULL)
       ON CONFLICT (table_name)
       DO UPDATE SET analysis = NULL, updated_at = CURRENT_TIMESTAMP`,
      [tableName]
    );

    const insertSql = (rows: number) => {
      const tuples = Array.from({ length: rows }, (_, row) =>
        `(${columns.map((_, column) => `$${row * columns.length + column + 1}`).join(', ')})`
      );
      return `INSERT INTO ${table} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')}`;
    };

    let batch: (string | null)[][] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await client.query(insertSql(batch.length), batch.flat());
      batch = [];
    };

    for await (const record of openParser()) {
      // Empty CSV fields are NULL, which also keeps them valid in numeric and timestamp columns.
      batch.push(columns.map(column => (record[column] === '' ? null : record[column])));
      if (batch.length >= rowsPerInsert) await flush();
    }
    await flush();
  });

  return { columns, columnTypes, rowCount };
}
