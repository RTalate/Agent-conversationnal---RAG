import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../helpers/harness';

// With DB_READONLY_USER set, the SQL written by the AI runs as a role that can only SELECT.
// The harness creates that role with the statements from the README ("Security notes"), so these
// tests also check that the documented setup works, including for tables created later.

const INSUFFICIENT_PRIVILEGE = '42501';

describe('AI-generated SQL with a dedicated read-only role (DB_READONLY_USER)', () => {
  let h: Harness;
  let queryReadOnly: (sql: string, timeoutMs?: number) => Promise<{ rows: any[] }>;

  before(async () => {
    h = await startHarness({ readOnlyRole: true });
    ({ queryReadOnly } = await import('../../src/db'));
  });
  after(() => h.stop());
  beforeEach(() => h.reset());

  it('runs as the dedicated role, which is not a superuser', async () => {
    const { rows } = await queryReadOnly(
      'SELECT current_user AS name, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser'
    );
    assert.deepEqual(rows, [{ name: h.readOnlyRole, superuser: false }]);
  });

  it('cannot read files or list directories on the database server', async () => {
    await assert.rejects(() => queryReadOnly("SELECT pg_read_file('/etc/hostname')"), { code: INSUFFICIENT_PRIVILEGE });
    await assert.rejects(() => queryReadOnly("SELECT pg_ls_dir('/etc')"), { code: INSUFFICIENT_PRIVILEGE });
  });

  it('can read a table that existed when the role was created', async () => {
    // table_schema is created by the application right after the role, so it is covered by the default privileges
    assert.deepEqual((await queryReadOnly('SELECT count(*)::int AS n FROM table_schema')).rows, [{ n: 0 }]);
  });

  it('can read a table created later, by an upload', async () => {
    const upload = await h.upload('later', 'a,b\n1,x\n2,y\n');
    assert.equal(upload.status, 200);
    assert.deepEqual((await queryReadOnly('SELECT a, b FROM later ORDER BY a')).rows, [{ a: 1, b: 'x' }, { a: 2, b: 'y' }]);
  });

  it('an upload can still replace its own table: the role does not get in the way', async () => {
    assert.equal((await h.upload('replaced', 'a\n1\n')).status, 200);
    assert.equal((await h.upload('replaced', 'a\n1\n2\n3\n')).status, 200);
    assert.deepEqual((await queryReadOnly('SELECT count(*)::int AS n FROM replaced')).rows, [{ n: 3 }]);
  });

  it('through /query: a query the role is not allowed to run is reported to the AI, which can retry', async () => {
    await h.upload('customers', 'country\nFrance\nSpain\n');
    h.ai.useSql("SELECT pg_read_file('/etc/hostname') AS leaked", 'SELECT count(*)::int AS n FROM customers');

    const { status, body } = await h.ask('How many customers are there?');

    assert.equal(status, 200);
    assert.match(body.response, /"n":2/);
    assert.doesNotMatch(body.response, /leaked/);
    const [retry] = h.ai.callsTo('sqlRetry');
    assert.ok(retry, 'the failure was not reported back to the AI');
    assert.match(retry.user, /pg_read_file/);
  });
});
